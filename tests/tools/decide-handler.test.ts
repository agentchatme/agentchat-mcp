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
// the tests pin (1) the input contract — enums, bounds, and the cross-field
// defer_seconds rule at the schema, handler AND protocol layers, (2) the exact
// request each verdict sends, (3) the result shaping and the `next` line,
// (4) endpoint-aware 404 / 429 / 400 guidance, (5) no network without an
// identity, (6) a verdict POST is never retried.

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

describe('agentchat_decide input schema', () => {
  const shape = z.object(decide.INPUT_SHAPE)

  it('accepts every verdict and every category', () => {
    for (const decision of decide.DECISIONS) {
      expect(decide.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', decision }).success).toBe(true)
    }
    for (const category of decide.CATEGORIES) {
      expect(
        decide.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', decision: 'reply', category }).success,
      ).toBe(true)
    }
  })

  it('rejects an unknown decision or category, and a missing conversation_id', () => {
    expect(shape.safeParse({ conversation_id: 'conv_1', decision: 'maybe' }).success).toBe(false)
    expect(shape.safeParse({ conversation_id: 'conv_1', decision: 'reply', category: 'boredom' }).success).toBe(false)
    expect(shape.safeParse({ decision: 'reply' }).success).toBe(false)
    expect(shape.safeParse({ conversation_id: '', decision: 'reply' }).success).toBe(false)
  })

  it('rejects defer_seconds with reply or dismiss — in INPUT_SCHEMA, with the rule as the message', () => {
    for (const decision of ['reply', 'dismiss'] as const) {
      const parsed = decide.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', decision, defer_seconds: 600 })
      expect(parsed.success).toBe(false)
      const issues = parsed.success ? [] : parsed.error.issues
      expect(issues).toHaveLength(1)
      expect(issues[0]!.path).toEqual(['defer_seconds'])
      expect(issues[0]!.message).toBe(decide.DEFER_SECONDS_RULE)
    }
    // The rule is cross-field, so it lives on the object schema, not the shape.
    expect(shape.safeParse({ conversation_id: 'conv_1', decision: 'dismiss', defer_seconds: 600 }).success).toBe(true)
    expect(decide.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', decision: 'defer', defer_seconds: 600 }).success).toBe(true)
  })

  it('enforces the bounds: defer_seconds 60–86400 integer, through_message_id 1–128 chars', () => {
    const defer = (defer_seconds: unknown) =>
      decide.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', decision: 'defer', defer_seconds }).success
    expect(defer(decide.MIN_DEFER_SECONDS)).toBe(true)
    expect(defer(decide.MAX_DEFER_SECONDS)).toBe(true)
    expect(defer(decide.MIN_DEFER_SECONDS - 1)).toBe(false)
    expect(defer(decide.MAX_DEFER_SECONDS + 1)).toBe(false)
    expect(defer(90.5)).toBe(false)
    expect(defer('900')).toBe(false)

    const through = (through_message_id: string) =>
      shape.safeParse({ conversation_id: 'conv_1', decision: 'reply', through_message_id }).success
    expect(through('m')).toBe(true)
    expect(through('m'.repeat(128))).toBe(true)
    expect(through('m'.repeat(129))).toBe(false)
    expect(through('')).toBe(false)
  })

  it('emits the enums and bounds as JSON Schema; the refine adds nothing to the wire shape', () => {
    const opts = { target: 'draft-7', io: 'input' } as const
    expect(z.toJSONSchema(decide.INPUT_SCHEMA, opts)).toEqual(z.toJSONSchema(shape, opts))

    const schema = z.toJSONSchema(decide.INPUT_SCHEMA, opts)
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect(schema['required']).toEqual(['conversation_id', 'decision'])
    expect(props['decision']).toMatchObject({ type: 'string', enum: [...decide.DECISIONS] })
    expect(props['category']).toMatchObject({ type: 'string', enum: [...decide.CATEGORIES] })
    expect(props['through_message_id']).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 })
    expect(props['defer_seconds']).toMatchObject({
      type: 'integer',
      minimum: decide.MIN_DEFER_SECONDS,
      maximum: decide.MAX_DEFER_SECONDS,
    })
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
      recorded_at: RECORDED_AT,
      next: decide.NEXT.reply,
    })
    expect(decide.NEXT.reply).toBe(
      'Send your reply with agentchat_send_message, then agentchat_wait to keep the exchange live.',
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
      next: 'Done with this conversation for now. Call agentchat_wait if you expect more.',
    })
  })

  it('defer with defer_seconds: sends it and returns the server defer_until', async () => {
    const { impl, calls } = fetchStub(() =>
      json(201, recorded({ decision: 'defer', defer_until: '2026-11-01T10:30:00.000Z' })),
    )
    const result = await decide.createHandler(makeCtx(impl))({
      conversation_id: 'conv_1',
      decision: 'defer',
      defer_seconds: 1800,
    })
    expect(result.isError).toBeFalsy()
    expect(calls[0]!.body).toEqual({ decision: 'defer', defer_seconds: 1800 })
    expect(payloadOf(result)).toMatchObject({
      decision: 'defer',
      category: null,
      defer_until: '2026-11-01T10:30:00.000Z',
      recorded_at: RECORDED_AT,
      next: 'You will be reminded after defer_until; nothing else to do now.',
    })
  })

  it('defer without defer_seconds: sends none, so the server default (900 s) applies', async () => {
    const { impl, calls } = fetchStub(() =>
      json(201, recorded({ decision: 'defer', defer_until: '2026-11-01T10:15:00.000Z' })),
    )
    const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'defer' })
    expect(result.isError).toBeFalsy()
    expect(calls[0]!.body).toEqual({ decision: 'defer' })
    expect(payloadOf(result)['defer_until']).toBe('2026-11-01T10:15:00.000Z')
    expect(decide.SERVER_DEFAULT_DEFER_SECONDS).toBe(900)
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
      recorded_at: null,
      next: decide.NEXT.dismiss,
    })
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
        json(400, { code: 'VALIDATION_ERROR', message: 'defer_seconds requires decision=defer' }),
      )
      const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'defer', defer_seconds: 60 })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('Error: VALIDATION_ERROR')
      expect(text).toContain('defer_seconds requires decision=defer')
      expect(text).toContain('only sent with defer')
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

    it('handler guard: defer_seconds with dismiss is refused before any network call', async () => {
      const { impl, calls } = fetchStub(() => json(201, recorded({})))
      const result = await decide.createHandler(makeCtx(impl))({ conversation_id: 'conv_1', decision: 'dismiss', defer_seconds: 600 })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${decide.DEFER_SECONDS_RULE}`)
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

  it('tools/list advertises the enums, bounds and required fields', async () => {
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
      expect(schema.properties!['defer_seconds']).toMatchObject({
        type: 'integer',
        minimum: decide.MIN_DEFER_SECONDS,
        maximum: decide.MAX_DEFER_SECONDS,
      })
    } finally {
      await close()
    }
  })

  it('rejects defer_seconds without defer, and a bad decision, at the protocol layer with zero network calls', async () => {
    const { impl, calls } = fetchStub(() => json(201, recorded({})))
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect(KEY)
    try {
      const mixed = await client.callTool({
        name: decide.NAME,
        arguments: { conversation_id: 'conv_1', decision: 'dismiss', defer_seconds: 600 },
      })
      expect(mixed.isError).toBe(true)
      expect(firstText(mixed as { content: unknown[] })).toContain('defer_seconds')

      const bad = await client.callTool({
        name: decide.NAME,
        arguments: { conversation_id: 'conv_1', decision: 'shrug' },
      })
      expect(bad.isError).toBe(true)
      expect(calls).toHaveLength(0)
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
