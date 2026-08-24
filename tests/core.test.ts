import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMcpServer, PACKAGE_VERSION } from '../src/lib.js'

// ─── Hosted core (buildMcpServer) behavior ─────────────────────────────────
//
// Exercises the PUBLIC library entry end-to-end over a real MCP transport
// pair: identity binding, the NOT_AUTHENTICATED contract, the in-band
// registration flow with a stubbed network, and — critically — that the
// core reads NOTHING ambient (process.env keys and turn keys must not leak
// into a hosted session).

type FetchCall = { url: string; method: string; headers: Headers; body: unknown }

function fetchStub(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
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

async function connect(server: ReturnType<typeof buildMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'core-test', version: '0.0.0' })
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> })
    .content
  return content?.[0]?.text ?? ''
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('buildMcpServer — construction', () => {
  it('rejects a malformed apiBase with a clear error', () => {
    expect(() => buildMcpServer({ apiBase: 'not-a-url', apiKey: null })).toThrow(
      /apiBase must be an absolute http\(s\) URL/,
    )
    expect(() =>
      buildMcpServer({ apiBase: 'ftp://x.example', apiKey: null }),
    ).toThrow(/must use http\(s\)/)
  })

  it('rejects an out-of-range maxConcurrentTools', () => {
    expect(() =>
      buildMcpServer({ apiBase: 'https://x.example', apiKey: null, maxConcurrentTools: 0 }),
    ).toThrow(/maxConcurrentTools/)
  })

  it('rejects a userAgent with control characters (header-injection guard)', () => {
    expect(() =>
      buildMcpServer({
        apiBase: 'https://x.example',
        apiKey: null,
        userAgent: 'evil\r\nX-Injected: 1',
      }),
    ).toThrow(/userAgent/)
  })

  it('rejects a userAgent with chars above U+00FF (ByteString guard) at build time', () => {
    // Headers.set would otherwise throw at REQUEST time on every call,
    // surfacing as a bogus CONNECTION_ERROR instead of a build-time error.
    for (const bad of ['agentchat→hosted/1.0', 'bot 🚀', 'sm–dash']) {
      expect(() =>
        buildMcpServer({ apiBase: 'https://x.example', apiKey: null, userAgent: bad }),
      ).toThrow(/userAgent/)
    }
    // Printable Latin-1 (single-byte) stays allowed.
    expect(() =>
      buildMcpServer({
        apiBase: 'https://x.example',
        apiKey: null,
        userAgent: 'agentchat-hosté/1.0',
      }),
    ).not.toThrow()
  })

  it('rejects a malformed selfHandle at build time and accepts valid forms', () => {
    for (const bad of ['Bad_Handle', '@UPPER', 'a--b', '-lead', '@', '9start', 'trail-']) {
      expect(() =>
        buildMcpServer({ apiBase: 'https://x.example', apiKey: null, selfHandle: bad }),
      ).toThrow(/selfHandle/)
    }
    for (const good of ['self-bot', '@self-bot', 'a2', '@research-bot-7']) {
      expect(() =>
        buildMcpServer({ apiBase: 'https://x.example', apiKey: null, selfHandle: good }),
      ).not.toThrow()
    }
  })
})

describe('buildMcpServer — unauthenticated session (apiKey: null)', () => {
  it('still lists the full tool surface', async () => {
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      const { tools } = await client.listTools()
      const names = new Set(tools.map((t) => t.name))
      expect(names.has('agentchat_send_message')).toBe(true)
      expect(names.has('agentchat_register')).toBe(true)
      expect(names.has('agentchat_verify_otp')).toBe(true)
      expect(names.has('agentchat_set_webhook')).toBe(true)
      expect(names.has('agentchat_clear_webhook')).toBe(true)
      expect(tools.length).toBe(22)
    } finally {
      await close()
    }
  })

  it('fails identity-bound tools with structured NOT_AUTHENTICATED guidance', async () => {
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      for (const name of [
        'agentchat_get_my_status',
        'agentchat_set_webhook',
        'agentchat_clear_webhook',
      ]) {
        const result = await client.callTool({
          name,
          arguments:
            name === 'agentchat_set_webhook'
              ? { url: 'https://hooks.example/wake', secret: 's3cret-value' }
              : {},
        })
        expect(result.isError, `${name} should fail unauthenticated`).toBe(true)
        const text = firstText(result)
        expect(text).toContain('NOT_AUTHENTICATED')
        expect(text).toContain('Authorization: Bearer')
        expect(text).toContain('agentchat_register')
      }
    } finally {
      await close()
    }
  })

  it('ignores ambient AGENTCHAT_API_KEY — the hosted core reads no env', async () => {
    vi.stubEnv('AGENTCHAT_API_KEY', 'ac_live_0123456789abcdef0123456789abcdef')
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_get_my_status',
        arguments: {},
      })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain('NOT_AUTHENTICATED')
    } finally {
      await close()
    }
  })

  it('treats an empty/whitespace apiKey as unauthenticated', async () => {
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: '   ' })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_get_my_status',
        arguments: {},
      })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain('NOT_AUTHENTICATED')
    } finally {
      await close()
    }
  })

  it('completes agentchat_register without a key, on the given apiBase', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, { pending_id: 'pend_123', message: 'code sent' }),
    )
    vi.stubGlobal('fetch', impl)
    // Trailing slashes must not produce `//v1/...` requests.
    const server = buildMcpServer({ apiBase: 'https://api.staging.example//', apiKey: null })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_register',
        arguments: { email: 'owner@example.com', handle: 'fresh-bot' },
      })
      expect(result.isError).toBeFalsy()
      const payload = JSON.parse(firstText(result)) as Record<string, unknown>
      expect(payload['ok']).toBe(true)
      expect(payload['pending_id']).toBe('pend_123')
      expect(String(payload['next_step'])).toContain('agentchat_verify_otp')

      expect(calls).toHaveLength(1)
      expect(calls[0]!.method).toBe('POST')
      expect(calls[0]!.url).toBe('https://api.staging.example/v1/register')
      expect(calls[0]!.body).toEqual({ email: 'owner@example.com', handle: 'fresh-bot' })
      expect(calls[0]!.headers.get('x-agentchat-client')).toBe('mcp')
      expect(calls[0]!.headers.get('x-agentchat-client-version')).toBe(PACKAGE_VERSION)
      expect(calls[0]!.headers.get('authorization')).toBeNull()
    } finally {
      await close()
    }
  })

  it('surfaces register server errors faithfully, with actionable guidance', async () => {
    const { impl } = fetchStub(() =>
      json(409, { code: 'HANDLE_TAKEN', message: 'handle fresh-bot is taken' }),
    )
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_register',
        arguments: { email: 'owner@example.com', handle: 'fresh-bot' },
      })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('HANDLE_TAKEN')
      expect(text).toContain('handle fresh-bot is taken')
      expect(text).toContain('different handle')
    } finally {
      await close()
    }
  })

  it('rejects an invalid handle at the schema layer before any network call', async () => {
    const { impl, calls } = fetchStub(() => json(200, { pending_id: 'pend_x' }))
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_register',
        arguments: { email: 'owner@example.com', handle: 'Bad_Handle!' },
      })
      expect(result.isError).toBe(true)
      expect(calls).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('completes agentchat_verify_otp and returns the key exactly once, with storage guidance', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, {
        api_key: 'ac_live_ffffffffffffffffffffffffffffffff',
        agent: { handle: 'fresh-bot', status: 'active' },
      }),
    )
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_verify_otp',
        arguments: { pending_id: 'pend_123', code: '123456' },
      })
      expect(result.isError).toBeFalsy()
      const payload = JSON.parse(firstText(result)) as Record<string, unknown>
      expect(payload['api_key']).toBe('ac_live_ffffffffffffffffffffffffffffffff')
      expect(payload['handle']).toBe('fresh-bot')
      expect(String(payload['important'])).toMatch(/shown exactly once/i)
      expect(String(payload['important'])).toContain('Authorization: Bearer')

      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe('https://x.example/v1/register/verify')
      expect(calls[0]!.body).toEqual({ pending_id: 'pend_123', code: '123456' })
    } finally {
      await close()
    }
  })
})

describe('buildMcpServer — authenticated session', () => {
  const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

  it('binds the given key as Bearer auth for identity-bound tools', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, { handle: 'hosted-bot', status: 'active', paused_by_owner: 'none' }),
    )
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: KEY })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_get_my_status',
        arguments: {},
      })
      expect(result.isError).toBeFalsy()
      expect(JSON.parse(firstText(result))).toMatchObject({ handle: 'hosted-bot' })
      const me = calls.find((c) => c.url === 'https://x.example/v1/agents/me')
      expect(me).toBeDefined()
      expect(me!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    } finally {
      await close()
    }
  })

  it('sets the wake webhook over PUT with Bearer auth and passes the state through', async () => {
    const { impl, calls } = fetchStub(() => json(200, { state: 'active' }))
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: KEY })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_set_webhook',
        arguments: { url: 'https://hooks.example/wake', secret: 'shhh-long-secret' },
      })
      expect(result.isError).toBeFalsy()
      expect(JSON.parse(firstText(result))).toEqual({ ok: true, state: 'active' })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.method).toBe('PUT')
      expect(calls[0]!.url).toBe('https://x.example/v1/agents/me/wake-webhook')
      expect(calls[0]!.body).toEqual({
        url: 'https://hooks.example/wake',
        secret: 'shhh-long-secret',
      })
      expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    } finally {
      await close()
    }
  })

  it('never inherits an ambient turn-idempotency key from the environment', async () => {
    vi.stubEnv('AGENTCHAT_TURN_IDEMPOTENCY_KEY', 'ambient-turn-key')
    const { impl, calls } = fetchStub(() =>
      json(200, {
        id: 'msg_1',
        conversation_id: 'conv_1',
        seq: 1,
        created_at: '2026-08-23T00:00:00Z',
      }),
    )
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: KEY })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_send_message',
        arguments: { to: '@peer', text: 'hello from hosted' },
      })
      expect(result.isError).toBeFalsy()
      const send = calls.find((c) => c.url === 'https://x.example/v1/messages')
      expect(send).toBeDefined()
      const body = send!.body as Record<string, unknown>
      // The SDK always sets a fresh client_msg_id; the deterministic ac_turn_
      // form must never appear in a hosted session, env var or not.
      expect(String(body['client_msg_id'])).not.toMatch(/^ac_turn_/)
    } finally {
      await close()
    }
  })

  it('forwards the session client IP on unauthenticated AND authenticated calls when configured', async () => {
    const { impl, calls } = fetchStub((call) =>
      call.url.endsWith('/v1/register')
        ? json(200, { pending_id: 'pend_ip' })
        : json(200, { handle: 'hosted-bot', status: 'active' }),
    )
    vi.stubGlobal('fetch', impl)

    const unauth = buildMcpServer({
      apiBase: 'https://x.example',
      apiKey: null,
      clientIp: '203.0.113.7',
    })
    const a = await connect(unauth)
    try {
      await a.client.callTool({
        name: 'agentchat_register',
        arguments: { email: 'owner@example.com', handle: 'ip-bot' },
      })
    } finally {
      await a.close()
    }
    expect(calls[0]!.url).toBe('https://x.example/v1/register')
    expect(calls[0]!.headers.get('x-forwarded-for')).toBe('203.0.113.7')

    const authed = buildMcpServer({
      apiBase: 'https://x.example',
      apiKey: KEY,
      clientIp: '2001:db8::17',
    })
    const b = await connect(authed)
    try {
      await b.client.callTool({ name: 'agentchat_get_my_status', arguments: {} })
    } finally {
      await b.close()
    }
    const me = calls.find((c) => c.url === 'https://x.example/v1/agents/me')
    expect(me).toBeDefined()
    expect(me!.headers.get('x-forwarded-for')).toBe('2001:db8::17')
  })

  it('sends no x-forwarded-for header when clientIp is not configured', async () => {
    const { impl, calls } = fetchStub(() => json(200, { pending_id: 'pend_noip' }))
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      await client.callTool({
        name: 'agentchat_register',
        arguments: { email: 'owner@example.com', handle: 'noip-bot' },
      })
    } finally {
      await close()
    }
    expect(calls[0]!.headers.get('x-forwarded-for')).toBeNull()
  })

  it('rejects a malformed clientIp at build time', () => {
    for (const bad of ['not-an-ip', '203.0.113.7:443', 'a.b.c.d', '1.2.3.4\r\nX: y']) {
      expect(() =>
        buildMcpServer({ apiBase: 'https://x.example', apiKey: null, clientIp: bad }),
      ).toThrow(/clientIp/)
    }
  })

  it('attaches the configured userAgent to upstream API requests', async () => {
    const { impl, calls } = fetchStub(() => json(200, { pending_id: 'pend_ua' }))
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({
      apiBase: 'https://x.example',
      apiKey: null,
      userAgent: 'agentchat-hosted-mcp/9.9-test',
    })
    const { client, close } = await connect(server)
    try {
      await client.callTool({
        name: 'agentchat_register',
        arguments: { email: 'owner@example.com', handle: 'ua-bot' },
      })
      expect(calls[0]!.headers.get('user-agent')).toBe('agentchat-hosted-mcp/9.9-test')
    } finally {
      await close()
    }
  })

  it('uses the provided turnKey source: sends carry the deterministic ac_turn_ client_msg_id', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, {
        id: 'msg_t',
        conversation_id: 'conv_t',
        seq: 3,
        created_at: '2026-08-24T00:00:00Z',
      }),
    )
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({
      apiBase: 'https://x.example',
      apiKey: KEY,
      turnKey: () => 'gateway-turn-abc',
    })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_send_message',
        arguments: { to: '@peer', text: 'idempotent hello' },
      })
      expect(result.isError).toBeFalsy()
      const send = calls.find((c) => c.url === 'https://x.example/v1/messages')
      expect(send).toBeDefined()
      const body = send!.body as Record<string, unknown>
      expect(String(body['client_msg_id'])).toMatch(/^ac_turn_[0-9a-f]{64}$/)
    } finally {
      await close()
    }
  })

  it('answers a rejected key with the HOSTED-flavored UNAUTHORIZED guidance', async () => {
    const { impl } = fetchStub(() =>
      json(401, { code: 'UNAUTHORIZED', message: 'bad key' }),
    )
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: KEY })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_get_my_status',
        arguments: {},
      })
      expect(result.isError).toBe(true)
      const text = firstText(result)
      expect(text).toContain('UNAUTHORIZED')
      expect(text).toContain('Authorization: Bearer')
      expect(text).toContain('agentchat_register')
      expect(text).not.toContain('AGENTCHAT_API_KEY')
    } finally {
      await close()
    }
  })
})

describe('buildMcpServer — selfHandle identity binding', () => {
  const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

  it('classifies the agent\'s own messages correctly via the provided selfHandle, with ZERO /v1/agents/me calls', async () => {
    const messagesNewestFirst = [
      {
        id: 'msg_self',
        conversation_id: 'conv_1',
        sender: 'self-bot',
        seq: 2,
        type: 'text',
        content: { text: 'my own message' },
        context: { sender: { handle: 'self-bot' } },
        status: 'delivered',
        created_at: '2026-08-24T00:01:00Z',
      },
      {
        id: 'msg_peer',
        conversation_id: 'conv_1',
        sender: 'peer-bot',
        seq: 1,
        type: 'text',
        content: { text: 'their message' },
        context: { sender: { handle: 'peer-bot' } },
        status: 'delivered',
        created_at: '2026-08-24T00:00:00Z',
      },
    ]
    const { impl, calls } = fetchStub((call) =>
      call.url.includes('/v1/messages/conv_1')
        ? json(200, messagesNewestFirst)
        : json(404, { code: 'NOT_FOUND', message: 'no context endpoint' }),
    )
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({
      apiBase: 'https://x.example',
      apiKey: KEY,
      selfHandle: '@self-bot',
    })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_get_conversation',
        arguments: { conversation_id: 'conv_1' },
      })
      expect(result.isError).toBeFalsy()
      const payload = JSON.parse(firstText(result)) as {
        focus: { message_id: string; is_incoming: boolean }
        messages: Array<{
          message_id: string
          sender: { handle: string }
          delivery: { scope: string }
        }>
      }
      // Own message: receipt scope flips to the counterparty's receipt.
      const own = payload.messages.find((m) => m.message_id === 'msg_self')!
      const peer = payload.messages.find((m) => m.message_id === 'msg_peer')!
      expect(own.delivery.scope).toBe('counterparty_receipt')
      expect(peer.delivery.scope).toBe('your_receipt')
      // Focus (the newest message) is the agent's own → not incoming.
      expect(payload.focus.message_id).toBe('msg_self')
      expect(payload.focus.is_incoming).toBe(false)
      // The whole point: the handle was NEVER fetched.
      expect(calls.some((c) => c.url.includes('/v1/agents/me'))).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('buildMcpServer — set_webhook schema contract', () => {
  const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

  it('advertises the https-only rule in the tools/list input schema', async () => {
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: null })
    const { client, close } = await connect(server)
    try {
      const { tools } = await client.listTools()
      const setWebhook = tools.find((t) => t.name === 'agentchat_set_webhook')!
      const urlSchema = (
        setWebhook.inputSchema as {
          properties: Record<string, { pattern?: string }>
        }
      ).properties['url']!
      expect(String(urlSchema.pattern)).toContain('https')
    } finally {
      await close()
    }
  })

  it('rejects a plain-http url at the MCP schema layer with zero network calls', async () => {
    const { impl, calls } = fetchStub(() => json(200, { state: 'active' }))
    vi.stubGlobal('fetch', impl)
    const server = buildMcpServer({ apiBase: 'https://x.example', apiKey: KEY })
    const { client, close } = await connect(server)
    try {
      const result = await client.callTool({
        name: 'agentchat_set_webhook',
        arguments: { url: 'http://hooks.example/wake', secret: 's3cret-value' },
      })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain('Invalid arguments')
      expect(firstText(result)).toContain('https://')
      expect(calls).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
