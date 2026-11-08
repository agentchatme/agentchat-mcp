import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NotAuthenticatedError, NotRegisteredError } from '../../src/client.js'
import { buildMcpServer } from '../../src/lib.js'
import { Semaphore } from '../../src/semaphore.js'
import * as decide from '../../src/tools/decide.js'
import type { ToolContext } from '../../src/tools/_types.js'

// agentchat_decide: records the reply-gate verdict. Network boundary stubbed;
// the tests pin (1) the input contract — enums and bounds, and that
// `defer_seconds` is gone (the server owns the defer ladder), (2) the exact
// request each verdict sends, (3) the result shaping (defer_until +
// defer_step) and the `next` line, (4) endpoint-aware 404 / 429 / 400
// guidance, (5) no network without an identity, (6) a verdict POST is never
// retried, (7) a legacy caller's defer_seconds never reaches the wire.

type FetchCall = { url: string; method: string; headers: Headers; body: unknown }

function fetchStub(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { impl, calls }
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

function makeCtx(
  fetchImpl: typeof fetch,
  apiKey: string | null = KEY,
  mode: 'stdio' | 'hosted' = 'stdio',
): ToolContext {
  return {
    get client(): AgentChatClient {
      if (apiKey === null) {
        throw mode === 'hosted' ? new NotAuthenticatedError() : new NotRegisteredError()
      }
      return {} as AgentChatClient
    },
    logger: pino({ level: 'silent' }),
    selfHandle: '@me',
    semaphore: new Semaphore(10),
    inflight: new Set(),
    rest: { apiBase: 'https://api.agentchat.test', apiKey, fetchImpl },
    turnKey: () => undefined,
    mode,
  }
}

function firstText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text: string }>)[0]!.text
}

function payloadOf(result: { content: unknown[] }): Record<string, unknown> {
  return JSON.parse(firstText(result)) as Record<string, unknown>
}

const RECORDED_AT = '2026-11-01T10:00:00.000Z'

/** The server's 201 envelope, with overrides for the row. */
const recorded = (row: Record<string, unknown>) => ({
  decision: {
    id: 'dec_1',
    conversation_id: 'conv_1',
    decision: 'dismiss',
    category: null,
    through_message_id: null,
    defer_until: null,
    created_at: RECORDED_AT,
    ...row,
  },
})

const isDecision = (call: FetchCall) =>
  new URL(call.url).pathname === '/v1/conversations/conv_1/decisions'

const shape = z.object(decide.INPUT_SHAPE)

describe('agentchat_decide input schema', () => {
  it('accepts every verdict and every category', () => {
    for (const decision of decide.DECISIONS) {
      expect(shape.safeParse({ conversation_id: 'conv_1', decision }).success).toBe(true)
    }
    for (const category of decide.CATEGORIES) {
      expect(shape.safeParse({ conversation_id: 'conv_1', decision: 'reply', category }).success).toBe(true)
    }
  })

  it('rejects an unknown decision or category, and a missing conversation_id', () => {
    expect(shape.safeParse({ conversation_id: 'conv_1', decision: 'maybe' }).success).toBe(false)
    expect(shape.safeParse({ conversation_id: 'conv_1', decision: 'reply', category: 'boredom' }).success).toBe(false)
    expect(shape.safeParse({ decision: 'reply' }).success).toBe(false)
    expect(shape.safeParse({ conversation_id: '', decision: 'reply' }).success).toBe(false)
  })

  it('has no defer_seconds: the server owns the defer ladder, and the texts say so', () => {
    expect(Object.keys(decide.INPUT_SHAPE)).toEqual([
      'conversation_id',
      'decision',
      'category',
      'through_message_id',
    ])
    expect(decide.DESCRIPTION).toContain('the server owns the reminder ladder')
    expect(decide.DESCRIPTION).toContain('the tray’s question gives its steps')
    expect(decide.DESCRIPTION).toContain('a repeated `defer` climbs the ladder')
    expect(decide.INPUT_SHAPE.decision.description).toContain('each defer is one step of the server’s reminder ladder')
    expect(decide.NEXT.defer).toContain('The server reminds you at defer_until')
    expect(decide.NEXT.defer).toContain('a null defer_until means no more reminders until a newer message arrives')
    // The ladder's timings are the server's (served in the gate question and
    // in defer_until); no text here restates them, so none can go stale.
    const timings = /\b\d+\s*(min(ute)?s?|h(ours?)?|days?)\b|\+\d/i
    for (const text of [decide.DESCRIPTION, decide.INPUT_SHAPE.decision.description ?? '', ...Object.values(decide.NEXT)]) {
      expect(text).not.toMatch(timings)
    }
    // A legacy caller's extra field is stripped by the object schema, so an
    // old client keeps working and the server never sees defer_seconds.
    const parsed = shape.safeParse({ conversation_id: 'conv_1', decision: 'defer', defer_seconds: 600 })
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'defer_seconds' in parsed.data).toBe(false)
  })

  it('enforces the through_message_id bounds (1–128 chars)', () => {
    const through = (through_message_id: string) =>
      shape.safeParse({ conversation_id: 'conv_1', decision: 'reply', through_message_id }).success
    expect(through('m')).toBe(true)
    expect(through('m'.repeat(128))).toBe(true)
    expect(through('m'.repeat(129))).toBe(false)
    expect(through('')).toBe(false)
  })

  it('tells the model what each verdict does to read state, to anchor on the card, and to record reply only after the send', () => {
    expect(decide.DESCRIPTION).toContain('`dismiss` and `defer` right away')
    expect(decide.DESCRIPTION).toContain('then record `reply` — never before the send')
    expect(decide.DESCRIPTION).not.toContain('before you act on it')
    expect(decide.INPUT_SHAPE.decision.description).toContain('record it after your agentchat_send_message, never before')
    expect(decide.INPUT_SHAPE.through_message_id.description).toContain('never your own')
    expect(decide.DESCRIPTION).toContain(
      '`reply` and `dismiss` mark the conversation read through through_message_id',
    )
    expect(decide.DESCRIPTION).toContain('`defer` leaves everything unread')
    expect(decide.DESCRIPTION).toContain('Always pass through_message_id: the card’s `preview.message_id`, or for `reply` the newest message you read')
    expect(decide.INPUT_SHAPE.through_message_id.description).toContain('Always pass it')
    expect(decide.INPUT_SHAPE.through_message_id.description).toContain('preview.message_id')
    expect(decide.INPUT_SHAPE.decision.description).toContain('marks nothing read')
    // The anchor stays optional on the wire for older servers.
    expect(shape.safeParse({ conversation_id: 'conv_1', decision: 'dismiss' }).success).toBe(true)
  })

  it('emits the enums and bounds as JSON Schema, with a description on every field', () => {
    const schema = z.toJSONSchema(shape, { target: 'draft-7', io: 'input' })
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect(schema['required']).toEqual(['conversation_id', 'decision'])
    expect(Object.keys(props)).toEqual(['conversation_id', 'decision', 'category', 'through_message_id'])
    expect(props['decision']).toMatchObject({ type: 'string', enum: [...decide.DECISIONS] })
    expect(props['category']).toMatchObject({ type: 'string', enum: [...decide.CATEGORIES] })
    expect(props['through_message_id']).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 })
    for (const name of Object.keys(decide.INPUT_SHAPE)) {
      expect(typeof props[name]!['description'], `${name} needs a description`).toBe('string')
    }
  })
})

describe('agentchat_decide handler', () => {
  it('reply: POSTs the exact body with Bearer auth and no Idempotency-Key, and shapes the result', async () => {
    const { impl, calls } = fetchStub(() =>
      json(201, recorded({ decision: 'reply', category: 'open_request', through_message_id: 'msg_9' })),
    )
    const result = await decide.createHandler(makeCtx(impl))({
      conversation_id: 'conv_1',
      decision: 'reply',
      category: 'open_request',
      through_message_id: 'msg_9',
    })
    expect(result.isError).toBeFalsy()

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(isDecision(call)).toBe(true)
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(call.headers.get('content-type')).toContain('application/json')
    // A verdict is a new row every time: never retry-eligible, never keyed.
    expect(call.headers.get('idempotency-key')).toBeNull()
    expect(call.body).toEqual({ decision: 'reply', category: 'open_request', through_message_id: 'msg_9' })

    expect(payloadOf(result)).toEqual({
      you: '@me',
      conversation_id: 'conv_1',
      decision: 'reply',
      category: 'open_request',
      through_message_id: 'msg_9',
      defer_until: null,
      defer_step: null,
      recorded_at: RECORDED_AT,
      next: decide.NEXT.reply,
    })
    expect(decide.NEXT.reply).toBe(
      'Read through through_message_id. If your answer is not sent yet, send it now with agentchat_send_message (record reply after the send next time). Then agentchat_wait to keep the exchange live.',
    )
  })

  it('dismiss: only the fields that were set travel — no undefined keys on the wire', async () => {
    const { impl, calls } = fetchStub(() => json(201, recorded({ category: 'closing' })))
    const result = await decide.createHandler(makeCtx(impl))({
      conversation_id: 'conv_1',
      decision: 'dismiss',
      category: 'closing',
    })
    expect(result.isError).toBeFalsy()
    expect(calls[0]!.body).toEqual({ decision: 'dismiss', category: 'closing' })
    expect(Object.keys(calls[0]!.body as object)).toEqual(['decision', 'category'])

    expect(payloadOf(result)).toMatchObject({
      decision: 'dismiss',
      category: 'closing',
      through_message_id: null,
      defer_until: null,
      next: 'Done with this conversation: it is read through through_message_id and needs nothing from you. Next card, or agentchat_inbox again if you expect more.',
    })
  })

  it('defer: sends only the verdict; the server answers with the ladder step and its due time', async () => {
    const { impl, calls } = fetchStub(() =>
      json(201, recorded({ decision: 'defer', defer_until: '2026-11-01T10:15:00.000Z', defer_step: 1 })),
    )
    const result = await decide.createHandler(makeCtx(impl))({
      conversation_id: 'conv_1',
      decision: 'defer',
      through_message_id: 'msg_9',
    })
    expect(result.isError).toBeFalsy()
    expect(calls[0]!.body).toEqual({ decision: 'defer', through_message_id: 'msg_9' })
    expect(payloadOf(result)).toMatchObject({
      decision: 'defer',
      category: null,
      defer_until: '2026-11-01T10:15:00.000Z',
      defer_step: 1,
      recorded_at: RECORDED_AT,
      next: decide.NEXT.defer,
    })
  })

  it('defer at the end of the ladder: defer_until null, defer_step 3', async () => {
    const { impl } = fetchStub(() =>
      json(201, recorded({ decision: 'defer', defer_until: null, defer_step: 3 })),
    )
    const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'defer' })
    expect(payloadOf(result)).toMatchObject({ decision: 'defer', defer_until: null, defer_step: 3 })
  })

  it('an older server without defer_step: defer_step is null, defer_until as given', async () => {
    const { impl } = fetchStub(() =>
      json(201, recorded({ decision: 'defer', defer_until: '2026-11-01T10:15:00.000Z' })),
    )
    const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'defer' })
    expect(payloadOf(result)).toMatchObject({ defer_until: '2026-11-01T10:15:00.000Z', defer_step: null })
  })

  it('percent-encodes the conversation id in the path', async () => {
    const { impl, calls } = fetchStub(() => json(201, recorded({ conversation_id: 'grp_a/b' })))
    await decide.createHandler(makeCtx(impl))({ conversation_id: 'grp_a/b', decision: 'dismiss' })
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/conversations/grp_a%2Fb/decisions')
  })

  it('falls back to the input when the 201 body is not the expected envelope', async () => {
    const { impl } = fetchStub(() => json(201, {}))
    const result = await decide.createHandler(makeCtx(impl))({
      conversation_id: 'conv_1',
      decision: 'dismiss',
      category: 'acknowledgement',
    })
    expect(result.isError).toBeFalsy()
    expect(payloadOf(result)).toEqual({
      you: '@me',
      conversation_id: 'conv_1',
      decision: 'dismiss',
      category: 'acknowledgement',
      through_message_id: null,
      defer_until: null,
      defer_step: null,
      recorded_at: null,
      note: decide.RECORDED_WITHOUT_ROW_NOTE,
      next: decide.NEXT.dismiss,
    })
  })

  it('a 2xx with an empty, null or non-JSON body is a recorded verdict — success with a note, never an error to retry', async () => {
    // A retried defer would climb the server's ladder; the 2xx already
    // recorded the row, so the tool must not report a failure.
    const bodies: Array<() => Response> = [
      () => new Response(null, { status: 201 }),
      () => new Response('', { status: 201 }),
      () => new Response(null, { status: 204 }),
      () => json(201, null),
      () => new Response('<html>ok</html>', { status: 201, headers: { 'content-type': 'text/html' } }),
    ]
    for (const body of bodies) {
      const { impl, calls } = fetchStub(body)
      const result = await decide.createHandler(makeCtx(impl))({
        conversation_id: 'conv_1',
        decision: 'defer',
        through_message_id: 'msg_9',
      })
      expect(result.isError, firstText(result)).toBeFalsy()
      expect(calls).toHaveLength(1)
      expect(payloadOf(result)).toMatchObject({
        conversation_id: 'conv_1',
        decision: 'defer',
        through_message_id: 'msg_9',
        defer_until: null,
        defer_step: null,
        recorded_at: null,
        note: decide.RECORDED_WITHOUT_ROW_NOTE,
        next: decide.NEXT.defer,
      })
    }
    expect(decide.RECORDED_WITHOUT_ROW_NOTE).toContain('do not record it again')
  })

  it('a full row carries no note', async () => {
    const { impl } = fetchStub(() => json(201, recorded({ decision: 'dismiss' })))
    const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'dismiss' })
    expect(payloadOf(result)).not.toHaveProperty('note')
  })

  it('never retries a verdict: a 5xx is one attempt, reported as SERVER_ERROR', async () => {
    const { impl, calls } = fetchStub(() => json(500, { code: 'INTERNAL_ERROR', message: 'db' }))
    const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'dismiss' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: SERVER_ERROR')
    expect(calls).toHaveLength(1)
    expect(decide.REQUEST_TIMEOUT_MS).toBe(10_000)
  })

  describe('errors', () => {
    it('404: NOT_FOUND with the not-a-participant guidance (the server is opaque on purpose)', async () => {
      const { impl, calls } = fetchStub(() => json(404, { code: 'NOT_FOUND', message: 'Not found' }))
      const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'dismiss' })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('Error: NOT_FOUND')
      expect(text).toContain('No verdict was recorded')
      expect(text).toContain('not a participant')
      expect(calls).toHaveLength(1)
    })

    it('429: RATE_LIMITED with the per-hour verdict cap and the retry hint, one attempt', async () => {
      const { impl, calls } = fetchStub(() =>
        json(429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'retry-after': '120' }),
      )
      const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'reply' })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('Error: RATE_LIMITED')
      expect(text).toContain('capped per hour')
      expect(text).toContain('one verdict per conversation per burst')
      expect(text).toContain('Retry after: 120 seconds')
      expect(text).not.toContain('60 messages/second')
      expect(calls).toHaveLength(1)
    })

    it('400: VALIDATION_ERROR keeps the server message and adds the field rules', async () => {
      const { impl } = fetchStub(() =>
        json(400, { code: 'VALIDATION_ERROR', message: 'through_message_id too long' }),
      )
      const result = await decide.createHandler(makeCtx(impl))({
        conversation_id: 'conv_1',
        decision: 'defer',
        through_message_id: 'x',
      })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('Error: VALIDATION_ERROR')
      expect(text).toContain('through_message_id too long')
      expect(text).toContain('through_message_id is 1–128 characters')
      expect(text).not.toContain('defer_seconds')
    })
  })

  describe('identity', () => {
    it('stdio: NOT_REGISTERED without any network call', async () => {
      const { impl, calls } = fetchStub(() => json(201, recorded({})))
      const result = await decide.createHandler(makeCtx(impl, null))({ conversation_id: 'conv_1', decision: 'dismiss' })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain('NOT_REGISTERED')
      expect(calls).toHaveLength(0)
    })

    it('hosted: NOT_AUTHENTICATED without any network call', async () => {
      const { impl, calls } = fetchStub(() => json(201, recorded({})))
      const result = await decide.createHandler(makeCtx(impl, null, 'hosted'))({ conversation_id: 'conv_1', decision: 'dismiss' })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('NOT_AUTHENTICATED')
      expect(text).toContain('Authorization: Bearer')
      expect(calls).toHaveLength(0)
    })
  })
})

describe('agentchat_decide over the MCP protocol', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function connect(apiKey: string | null) {
    // A gateway that authenticated the key knows the handle and passes it;
    // without it the core resolves it with a lazy GET /v1/agents/me.
    const server = buildMcpServer({
      apiBase: 'https://api.agentchat.test',
      apiKey,
      ...(apiKey !== null ? { selfHandle: 'me' } : {}),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'decide-test', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it('tools/list advertises the enums and required fields, no defer_seconds, and non-idempotent write hints', async () => {
    const { client, close } = await connect(null)
    try {
      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === decide.NAME)
      expect(tool).toBeDefined()
      expect(tool!.description).toBe(decide.DESCRIPTION)
      const schema = tool!.inputSchema as { required?: string[]; properties?: Record<string, Record<string, unknown>> }
      expect(schema.required).toEqual(['conversation_id', 'decision'])
      expect(schema.properties!['decision']).toMatchObject({ enum: [...decide.DECISIONS] })
      expect(schema.properties!['category']).toMatchObject({ enum: [...decide.CATEGORIES] })
      expect(schema.properties!['defer_seconds']).toBeUndefined()
      // Not idempotent: a retried `defer` would climb the server's ladder.
      expect(tool!.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      })
    } finally {
      await close()
    }
  })

  it('a legacy caller’s defer_seconds is dropped before the wire; a bad decision is rejected with zero network calls', async () => {
    const { impl, calls } = fetchStub(() =>
      json(201, recorded({ decision: 'defer', defer_until: '2026-11-01T10:15:00.000Z', defer_step: 1 })),
    )
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect(KEY)
    try {
      const legacy = await client.callTool({
        name: decide.NAME,
        arguments: { conversation_id: 'conv_1', decision: 'defer', defer_seconds: 600 },
      })
      expect(legacy.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.body).toEqual({ decision: 'defer' })
      expect(payloadOf(legacy as { content: unknown[] })).toMatchObject({ defer_step: 1 })

      const bad = await client.callTool({
        name: decide.NAME,
        arguments: { conversation_id: 'conv_1', decision: 'shrug' },
      })
      expect(bad.isError).toBe(true)
      expect(calls).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('records a verdict end to end through the hosted core', async () => {
    const { impl, calls } = fetchStub(() => json(201, recorded({ category: 'no_action_needed' })))
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect(KEY)
    try {
      const result = await client.callTool({
        name: decide.NAME,
        arguments: { conversation_id: 'conv_1', decision: 'dismiss', category: 'no_action_needed' },
      })
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.body).toEqual({ decision: 'dismiss', category: 'no_action_needed' })
      // The hosted core normalizes selfHandle to the bare handle.
      expect(payloadOf(result as { content: unknown[] })).toMatchObject({
        you: 'me',
        decision: 'dismiss',
        category: 'no_action_needed',
        next: decide.NEXT.dismiss,
      })
    } finally {
      await close()
    }
  })

  it('an unauthenticated hosted session gets NOT_AUTHENTICATED with zero network calls', async () => {
    const { impl, calls } = fetchStub(() => json(201, recorded({})))
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect(null)
    try {
      const result = await client.callTool({
        name: decide.NAME,
        arguments: { conversation_id: 'conv_1', decision: 'dismiss' },
      })
      expect(result.isError).toBe(true)
      expect(firstText(result as { content: unknown[] })).toContain('NOT_AUTHENTICATED')
      expect(calls).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
