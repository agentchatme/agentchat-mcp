import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NotAuthenticatedError, NotRegisteredError } from '../../src/client.js'
import { buildMcpServer } from '../../src/lib.js'
import { Semaphore } from '../../src/semaphore.js'
import * as markRead from '../../src/tools/mark-read.js'
import type { ToolContext } from '../../src/tools/_types.js'

// agentchat_mark_read: the explicit read marker, in two forms. Network
// boundary stubbed; the tests pin (1) the exactly-one-form rule at the
// schema, handler AND protocol layers, (2) the single-message form still
// going through the SDK client exactly as before, (3) the exact request the
// conversation form sends to POST /v1/conversations/{id}/read and its
// result, (4) endpoint-aware 404 (NOT_FOUND / MESSAGE_NOT_FOUND) and 400
// guidance, (5) the idempotent retry, (6) no network without an identity.

type FetchCall = { url: string; method: string; headers: Headers; body: unknown }

function fetchStub(
  respond: (call: FetchCall, attempt: number) => Response | Promise<Response>,
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
    return respond(call, calls.length)
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
  options: {
    apiKey?: string | null
    mode?: 'stdio' | 'hosted'
    client?: Partial<AgentChatClient>
  } = {},
): ToolContext {
  const apiKey = options.apiKey === undefined ? KEY : options.apiKey
  const mode = options.mode ?? 'stdio'
  return {
    get client(): AgentChatClient {
      if (apiKey === null) {
        throw mode === 'hosted' ? new NotAuthenticatedError() : new NotRegisteredError()
      }
      return (options.client ?? {}) as AgentChatClient
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

const isConversationRead = (call: FetchCall) =>
  new URL(call.url).pathname === '/v1/conversations/conv_1/read'

const CONVERSATION_FORM = { conversation_id: 'conv_1', through_message_id: 'msg_9' }
const MESSAGE_FORM = { message_id: 'msg_42' }

describe('agentchat_mark_read input schema', () => {
  const shape = z.object(markRead.INPUT_SHAPE)

  it('accepts exactly the two forms', () => {
    expect(markRead.INPUT_SCHEMA.safeParse(MESSAGE_FORM).success).toBe(true)
    expect(markRead.INPUT_SCHEMA.safeParse(CONVERSATION_FORM).success).toBe(true)
    expect(markRead.formOf(MESSAGE_FORM)).toEqual({ kind: 'message', message_id: 'msg_42' })
    expect(markRead.formOf(CONVERSATION_FORM)).toEqual({ kind: 'conversation', ...CONVERSATION_FORM })
  })

  it('rejects an empty, partial or mixed call in INPUT_SCHEMA, with the rule as the message', () => {
    const bad = [
      {},
      { conversation_id: 'conv_1' },
      { through_message_id: 'msg_9' },
      { message_id: 'msg_42', conversation_id: 'conv_1' },
      { message_id: 'msg_42', through_message_id: 'msg_9' },
      { message_id: 'msg_42', ...CONVERSATION_FORM },
    ]
    for (const input of bad) {
      const parsed = markRead.INPUT_SCHEMA.safeParse(input)
      expect(parsed.success, JSON.stringify(input)).toBe(false)
      const issues = parsed.success ? [] : parsed.error.issues
      expect(issues).toHaveLength(1)
      expect(issues[0]!.message).toBe(markRead.FORM_RULE)
      expect(markRead.formOf(input)).toEqual({ issue: markRead.FORM_RULE })
      // The rule is cross-field, so it lives on the object schema, not the shape.
      expect(shape.safeParse(input).success).toBe(true)
    }
  })

  it('enforces the field bounds: non-empty ids, through_message_id ≤ 128 chars', () => {
    expect(markRead.INPUT_SCHEMA.safeParse({ message_id: '' }).success).toBe(false)
    expect(markRead.INPUT_SCHEMA.safeParse({ conversation_id: '', through_message_id: 'msg_9' }).success).toBe(false)
    expect(markRead.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', through_message_id: '' }).success).toBe(false)
    expect(markRead.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', through_message_id: 'm'.repeat(128) }).success).toBe(true)
    expect(markRead.INPUT_SCHEMA.safeParse({ conversation_id: 'conv_1', through_message_id: 'm'.repeat(129) }).success).toBe(false)
  })

  it('emits three optional described fields as JSON Schema; the refine adds nothing to the wire shape', () => {
    const opts = { target: 'draft-7', io: 'input' } as const
    expect(z.toJSONSchema(markRead.INPUT_SCHEMA, opts)).toEqual(z.toJSONSchema(shape, opts))
    const schema = z.toJSONSchema(markRead.INPUT_SCHEMA, opts)
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect(schema['required']).toBeUndefined()
    expect(Object.keys(props).sort()).toEqual(['conversation_id', 'message_id', 'through_message_id'])
    expect(props['through_message_id']).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 })
    for (const name of Object.keys(markRead.INPUT_SHAPE)) {
      expect(typeof props[name]!['description'], `${name} needs a description`).toBe('string')
    }
  })

  it('describes both forms, prefers the conversation one, and says looking never marks read', () => {
    expect(markRead.DESCRIPTION).toContain('conversation_id + through_message_id')
    expect(markRead.DESCRIPTION).toContain('message_id alone')
    expect(markRead.DESCRIPTION).toContain('compatibility path')
    expect(markRead.DESCRIPTION).toContain('agentchat_decide `reply` and `dismiss` already mark the conversation read')
    expect(markRead.DESCRIPTION).toContain('Looking never marks read')
    expect(markRead.DESCRIPTION).toContain('agentchat_wait (it marks delivered only)')
  })
})

describe('agentchat_mark_read handler', () => {
  describe('single-message form (compatibility)', () => {
    it('calls the SDK client exactly as before, makes no direct REST call, and keeps the result shape', async () => {
      const markAsRead = vi.fn().mockResolvedValue({ ok: true })
      const { impl, calls } = fetchStub(() => json(200, { read: 1 }))
      const result = await markRead.createHandler(makeCtx(impl, { client: { markAsRead } }))(MESSAGE_FORM)
      expect(result.isError).toBeFalsy()
      expect(markAsRead).toHaveBeenCalledWith('msg_42')
      expect(calls).toHaveLength(0)
      expect(payloadOf(result)).toEqual({ ok: true, message_id: 'msg_42' })
    })
  })

  describe('conversation form', () => {
    it('POSTs { through_message_id } to /v1/conversations/{id}/read with Bearer auth and an Idempotency-Key, and reports the count', async () => {
      const { impl, calls } = fetchStub(() => json(200, { read: 3 }))
      const markAsRead = vi.fn()
      const result = await markRead.createHandler(makeCtx(impl, { client: { markAsRead } }))(CONVERSATION_FORM)
      expect(result.isError).toBeFalsy()
      expect(markAsRead).not.toHaveBeenCalled()

      expect(calls).toHaveLength(1)
      const call = calls[0]!
      expect(call.method).toBe('POST')
      expect(isConversationRead(call)).toBe(true)
      expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
      expect(call.headers.get('content-type')).toContain('application/json')
      expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
      expect(call.body).toEqual({ through_message_id: 'msg_9' })
      expect(Object.keys(call.body as object)).toEqual(['through_message_id'])

      expect(payloadOf(result)).toEqual({
        ok: true,
        conversation_id: 'conv_1',
        through_message_id: 'msg_9',
        read: 3,
      })
    })

    it('read: 0 means everything was read already; an unexpected body reports null, never a made-up count', async () => {
      const zero = await markRead.createHandler(makeCtx(fetchStub(() => json(200, { read: 0 })).impl))(CONVERSATION_FORM)
      expect(payloadOf(zero)['read']).toBe(0)
      for (const body of [{}, { read: 'three' }, { read: -1 }, null]) {
        const result = await markRead.createHandler(makeCtx(fetchStub(() => json(200, body)).impl))(CONVERSATION_FORM)
        expect(result.isError).toBeFalsy()
        expect(payloadOf(result)['read']).toBeNull()
      }
    })

    it('percent-encodes the conversation id in the path', async () => {
      const { impl, calls } = fetchStub(() => json(200, { read: 1 }))
      await markRead.createHandler(makeCtx(impl))({ conversation_id: 'grp_a/b', through_message_id: 'msg_9' })
      expect(new URL(calls[0]!.url).pathname).toBe('/v1/conversations/grp_a%2Fb/read')
    })

    it('retries a transient 503 under the SAME Idempotency-Key, then succeeds', async () => {
      const { impl, calls } = fetchStub((_call, attempt) =>
        attempt === 1 ? json(503, { code: 'INTERNAL_ERROR', message: 'upstream' }) : json(200, { read: 2 }),
      )
      const result = await markRead.createHandler(makeCtx(impl))(CONVERSATION_FORM)
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(2)
      expect(calls[0]!.headers.get('idempotency-key')).toBe(calls[1]!.headers.get('idempotency-key'))
      expect(payloadOf(result)['read']).toBe(2)
      expect(markRead.READ_RETRY_POLICY).toEqual({ maxRetries: 2, baseDelayMs: 200, maxDelayMs: 1_000 })
      expect(markRead.REQUEST_TIMEOUT_MS).toBe(10_000)
    })

    describe('errors', () => {
      it('404 NOT_FOUND: not a participant, or a server without the endpoint — fall back to message_id', async () => {
        const { impl, calls } = fetchStub(() => json(404, { code: 'NOT_FOUND', message: 'Not found' }))
        const result = await markRead.createHandler(makeCtx(impl))(CONVERSATION_FORM)
        expect(result.isError).toBe(true)
        const text = firstText(result)
        expect(text).toContain('Error: NOT_FOUND')
        expect(text).toContain('Nothing was marked')
        expect(text).toContain('not a participant')
        expect(text).toContain('no conversation read endpoint yet')
        expect(text).toContain('one at a time with message_id')
        expect(calls).toHaveLength(1)
      })

      it('404 MESSAGE_NOT_FOUND: the anchor is not a message of this conversation', async () => {
        const { impl, calls } = fetchStub(() =>
          json(404, { code: 'MESSAGE_NOT_FOUND', message: 'Message not found in conversation' }),
        )
        const result = await markRead.createHandler(makeCtx(impl))(CONVERSATION_FORM)
        expect(result.isError).toBe(true)
        const text = firstText(result)
        expect(text).toContain('Error: NOT_FOUND')
        expect(text).toContain('through_message_id is not a message of this conversation')
        expect(text).toContain('Pass the card’s preview.message_id (last_message_id when preview is null), or a message_id agentchat_get_conversation returned for this same conversation.')
        expect(text).not.toContain('no conversation read endpoint')
        expect(calls).toHaveLength(1)
      })

      it('400 VALIDATION_ERROR keeps the server message and adds the body rule', async () => {
        const { impl } = fetchStub(() =>
          json(400, { code: 'VALIDATION_ERROR', message: 'through_message_id is required' }),
        )
        const result = await markRead.createHandler(makeCtx(impl))(CONVERSATION_FORM)
        expect(result.isError).toBe(true)
        const text = firstText(result)
        expect(text).toContain('Error: VALIDATION_ERROR')
        expect(text).toContain('through_message_id is required')
        expect(text).toContain('one message id (1–128 characters)')
      })

      it('a 5xx that never clears is SERVER_ERROR after the retry budget (3 attempts)', async () => {
        const { impl, calls } = fetchStub(() => json(500, { code: 'INTERNAL_ERROR', message: 'db' }))
        const result = await markRead.createHandler(makeCtx(impl))(CONVERSATION_FORM)
        expect(result.isError).toBe(true)
        expect(firstText(result)).toContain('Error: SERVER_ERROR')
        expect(calls).toHaveLength(markRead.READ_RETRY_POLICY.maxRetries + 1)
      })
    })
  })

  describe('the form rule at the handler (direct callers)', () => {
    it('refuses a mixed or empty call before any network or SDK call', async () => {
      for (const input of [{}, { conversation_id: 'conv_1' }, { message_id: 'msg_42', ...CONVERSATION_FORM }]) {
        const markAsRead = vi.fn()
        const { impl, calls } = fetchStub(() => json(200, { read: 1 }))
        const result = await markRead.createHandler(makeCtx(impl, { client: { markAsRead } }))(input)
        expect(result.isError).toBe(true)
        expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${markRead.FORM_RULE}`)
        expect(calls).toHaveLength(0)
        expect(markAsRead).not.toHaveBeenCalled()
      }
    })
  })

  describe('identity', () => {
    it('stdio: NOT_REGISTERED without any network call, for either form', async () => {
      for (const input of [CONVERSATION_FORM, MESSAGE_FORM]) {
        const { impl, calls } = fetchStub(() => json(200, { read: 1 }))
        const result = await markRead.createHandler(makeCtx(impl, { apiKey: null }))(input)
        expect(result.isError).toBe(true)
        expect(firstText(result)).toContain('NOT_REGISTERED')
        expect(calls).toHaveLength(0)
      }
    })

    it('hosted: NOT_AUTHENTICATED without any network call', async () => {
      const { impl, calls } = fetchStub(() => json(200, { read: 1 }))
      const result = await markRead.createHandler(makeCtx(impl, { apiKey: null, mode: 'hosted' }))(CONVERSATION_FORM)
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('NOT_AUTHENTICATED')
      expect(text).toContain('Authorization: Bearer')
      expect(calls).toHaveLength(0)
    })
  })
})

describe('agentchat_mark_read over the MCP protocol', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function connect(apiKey: string | null) {
    const server = buildMcpServer({
      apiBase: 'https://api.agentchat.test',
      apiKey,
      ...(apiKey !== null ? { selfHandle: 'me' } : {}),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'mark-read-test', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it('tools/list advertises three optional fields and the two-form description', async () => {
    const { client, close } = await connect(null)
    try {
      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === markRead.NAME)
      expect(tool).toBeDefined()
      expect(tool!.description).toBe(markRead.DESCRIPTION)
      const schema = tool!.inputSchema as { required?: string[]; properties?: Record<string, Record<string, unknown>> }
      expect(schema.required ?? []).toEqual([])
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['conversation_id', 'message_id', 'through_message_id'])
    } finally {
      await close()
    }
  })

  it('rejects a mixed call at the protocol layer with zero network calls', async () => {
    const { impl, calls } = fetchStub(() => json(200, { read: 1 }))
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect(KEY)
    try {
      const mixed = await client.callTool({
        name: markRead.NAME,
        arguments: { message_id: 'msg_42', ...CONVERSATION_FORM },
      })
      expect(mixed.isError).toBe(true)
      expect(firstText(mixed as { content: unknown[] })).toContain('message_id')
      const empty = await client.callTool({ name: markRead.NAME, arguments: {} })
      expect(empty.isError).toBe(true)
      expect(calls).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('marks a conversation read through the anchor end to end through the hosted core', async () => {
    const { impl, calls } = fetchStub(() => json(200, { read: 4 }))
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect(KEY)
    try {
      const result = await client.callTool({ name: markRead.NAME, arguments: CONVERSATION_FORM })
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      expect(isConversationRead(calls[0]!)).toBe(true)
      expect(calls[0]!.body).toEqual({ through_message_id: 'msg_9' })
      expect(payloadOf(result as { content: unknown[] })).toEqual({
        ok: true,
        conversation_id: 'conv_1',
        through_message_id: 'msg_9',
        read: 4,
      })
    } finally {
      await close()
    }
  })

  it('an unauthenticated hosted session gets NOT_AUTHENTICATED with zero network calls', async () => {
    const { impl, calls } = fetchStub(() => json(200, { read: 1 }))
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect(null)
    try {
      const result = await client.callTool({ name: markRead.NAME, arguments: CONVERSATION_FORM })
      expect(result.isError).toBe(true)
      expect(firstText(result as { content: unknown[] })).toContain('NOT_AUTHENTICATED')
      expect(calls).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
