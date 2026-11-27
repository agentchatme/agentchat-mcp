import { AgentChatClient, AgentChatError } from 'agentchatme'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NotRegisteredError } from '../../src/client.js'
import { Semaphore } from '../../src/semaphore.js'
import * as clearWebhook from '../../src/tools/clear-webhook.js'
import * as registerAccount from '../../src/tools/register.js'
import * as setWebhook from '../../src/tools/set-webhook.js'
import * as testWebhook from '../../src/tools/test-webhook.js'
import * as verifyOtp from '../../src/tools/verify-otp.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Onboarding + webhook handler call-shape tests ─────────────────────────
//
// Same discipline as handlers.test.ts, but these tools call SDK methods
// over an injected fetch (the session's `rest` view) — so the stubs sit
// at the network boundary and the tests exercise the REAL error-mapping
// pipeline (status → typed error → mapped tool message).

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

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

/** Authenticated stdio-style context. */
function makeCtx(fetchImpl: typeof fetch, apiKey: string | null = KEY): ToolContext {
  return {
    get client(): AgentChatClient {
      if (apiKey === null) throw new NotRegisteredError()
      return {} as AgentChatClient
    },
    logger: pino({ level: 'silent' }),
    selfHandle: '@test',
    semaphore: new Semaphore(10),
    inflight: new Set(),
    rest: { apiBase: 'https://api.agentchat.test', apiKey, fetchImpl },
    turnKey: () => undefined,
  }
}

function firstText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text: string }>)[0]!.text
}

describe('agentchat_register handler', () => {
  it('POSTs /v1/register unauthenticated and shapes the pending flow', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, { pending_id: 'pend_9', message: 'sent' }),
    )
    const handler = registerAccount.createHandler(makeCtx(impl, null))
    const result = await handler({ email: 'a@b.example', handle: 'new-bot' })

    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload).toMatchObject({ ok: true, pending_id: 'pend_9', message: 'sent' })
    expect(String(payload['next_step'])).toContain('a@b.example')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/register')
    // Registration must never send credentials, even when the session has one.
    const authed = registerAccount.createHandler(makeCtx(impl, KEY))
    await authed({ email: 'a@b.example', handle: 'new-bot' })
    expect(calls[1]!.headers.get('authorization')).toBeNull()
  })

  it('fails closed when the server omits pending_id', async () => {
    const { impl } = fetchStub(() => json(200, { message: 'ok but useless' }))
    const handler = registerAccount.createHandler(makeCtx(impl, null))
    const result = await handler({ email: 'a@b.example', handle: 'new-bot' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('pending_id')
  })

  it.each([
    ['HANDLE_TAKEN', 409, /different handle/],
    ['EMAIL_LIMIT_REACHED', 409, /different email address/],
    ['EMAIL_EXHAUSTED', 409, /different email/],
  ])('surfaces %s with the server message plus guidance', async (code, status, guidance) => {
    const { impl } = fetchStub(() => json(status, { code, message: `server says ${code}` }))
    const handler = registerAccount.createHandler(makeCtx(impl, null))
    const result = await handler({ email: 'a@b.example', handle: 'new-bot' })
    expect(result.isError).toBe(true)
    const text = firstText(result)
    expect(text).toContain(code)
    expect(text).toContain(`server says ${code}`)
    expect(text).toMatch(guidance)
  })

  it('EMAIL_EXHAUSTED as the server sends it (409, a lifetime cap): code, server message and guidance survive, one attempt, no retry hint', async () => {
    // The SDK types this code (EmailExhaustedError). Guidance is
    // appended to the original error in place — never re-minted onto a base
    // AgentChatError — so the class and its extras survive; for a guided
    // 429 the retry hint is kept too (tests/errors.test.ts, foreign-coded
    // 429). A lifetime cap has no retry time, and none is invented.
    const { impl, calls } = fetchStub(() =>
      json(409, {
        code: 'EMAIL_EXHAUSTED',
        message: 'server says EMAIL_EXHAUSTED',
        details: { limit: 30 },
      }),
    )
    const handler = registerAccount.createHandler(makeCtx(impl, null))
    const result = await handler({ email: 'a@b.example', handle: 'new-bot' })
    expect(result.isError).toBe(true)
    const text = firstText(result)
    expect(text).toContain('Error: EMAIL_EXHAUSTED')
    expect(text).toContain('server says EMAIL_EXHAUSTED')
    expect(text).toMatch(/different email/)
    expect(text).not.toContain('Retry after')
    expect(calls).toHaveLength(1)
  })

  it('maps a plain rate limit to RATE_LIMITED with the Retry-After hint, without retrying the POST', async () => {
    const { impl, calls } = fetchStub(() =>
      json(429, { code: 'RATE_LIMITED', message: 'slow down' }, { 'retry-after': '17' }),
    )
    const handler = registerAccount.createHandler(makeCtx(impl, null))
    const result = await handler({ email: 'a@b.example', handle: 'new-bot' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('RATE_LIMITED')
    expect(firstText(result)).toContain('Retry after: 17 seconds')
    // retry:'never' — an auto-retried register could email a second code.
    expect(calls).toHaveLength(1)
  })
})

describe('agentchat_verify_otp handler', () => {
  it('POSTs /v1/register/verify and returns key + handle + storage guidance', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, { api_key: 'ac_live_minted', agent: { handle: 'new-bot' } }),
    )
    const handler = verifyOtp.createHandler(makeCtx(impl, null))
    const result = await handler({ pending_id: 'pend_9', code: '654321' })

    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload['api_key']).toBe('ac_live_minted')
    expect(payload['handle']).toBe('new-bot')
    const storage = payload['store_the_key'] as Record<string, string>
    expect(storage['stdio_mcp_server']).toContain('AGENTCHAT_API_KEY')
    expect(storage['hosted_mcp_any_host']).toContain('Authorization: Bearer')

    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/register/verify')
    expect(calls[0]!.body).toEqual({ pending_id: 'pend_9', code: '654321' })
  })

  it('passes EXPIRED (400: the pending registration is gone) through with re-register guidance', async () => {
    const { impl } = fetchStub(() =>
      json(400, { code: 'EXPIRED', message: 'Registration expired or invalid. Please start again.' }),
    )
    const handler = verifyOtp.createHandler(makeCtx(impl, null))
    const result = await handler({ pending_id: 'pend_9', code: '654321' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: EXPIRED')
    expect(firstText(result)).toContain('Registration expired or invalid. Please start again.')
    expect(firstText(result)).toContain('call agentchat_register again')
  })

  it('keeps code, guidance and the retry hint for OTP_EMAIL_LOCKED (a 429 the SDK does not model)', async () => {
    // A 429 with a code the SDK does not know mints a RateLimitedError by
    // status; the wire code, the guided message and Retry-After all survive.
    const { impl } = fetchStub(() =>
      json(429, { code: 'OTP_EMAIL_LOCKED', message: 'Too many wrong codes for this email. Try again in 15 minutes.' }, { 'retry-after': '900' }),
    )
    const handler = verifyOtp.createHandler(makeCtx(impl, null))
    const result = await handler({ pending_id: 'pend_9', code: '654321' })
    expect(result.isError).toBe(true)
    const text = firstText(result)
    expect(text).toContain('Error: OTP_EMAIL_LOCKED')
    expect(text).toContain('Too many wrong codes for this email. Try again in 15 minutes.')
    expect(text).toContain('registering again does not lift the wait')
    expect(text).toContain('Retry after: 900 seconds.')
  })

  it('fails with explicit do-not-re-register guidance when success carries no api_key', async () => {
    const { impl } = fetchStub(() => json(200, { agent: { handle: 'new-bot' } }))
    const handler = verifyOtp.createHandler(makeCtx(impl, null))
    const result = await handler({ pending_id: 'pend_9', code: '654321' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('api_key')
  })
})

// ─── Connector sign-in: the `connect` answer ───────────────────────────────
//
// A sign-up started over HTTP with `finish: "connector"` answers the right
// code with `next_step: "connect"` and a connector address, never a key: the
// contract's `verify-connector-done` case (contract v1, "Sign-up flows";
// its body below, placeholders as there).

const CONNECT = {
  authorization_endpoint: 'https://api.agentchat.me/oauth/authorize',
  expires_at: '2026-11-17T10:04:00.000Z',
  issuer: 'https://api.agentchat.me',
  mcp_url: 'https://api.agentchat.me/mcp/connector/acg_example-not-a-real-grant',
  registration_endpoint: 'https://api.agentchat.me/oauth/register',
  resource: 'https://api.agentchat.me/mcp/connector/acg_example-not-a-real-grant',
  scope: 'agentchat',
  token_endpoint: 'https://api.agentchat.me/oauth/token',
}

const CONNECT_MESSAGE =
  'Email verified. @example-relay is registered. Add AgentChat to your runtime as a connector at connect.mcp_url (connect also lists the sign-in endpoints, if your runtime asks for them). When your person taps Connect, your runtime is signed in as @example-relay. The address signs in once, within 60 minutes. No API key is given.\nYou can claim your agent @example-relay on the AgentChat dashboard to see its conversations. This link expires in 10 minutes: https://app.agentchat.me/claim/acl_example-not-a-real-link\nNothing can wake you yet. If an integration (Hermes, OpenClaw, Claude Code, Codex) signed you up, it connects by itself within a minute; otherwise set up a wake: https://agentchat.me/skill.md#2-being-woken'

const CONNECT_ANSWER = {
  agent: {
    avatar_url: null,
    created_at: '2026-11-17T09:04:00.000Z',
    description: null,
    display_name: 'Example Relay',
    email: 'relay@example.com',
    handle: 'example-relay',
    is_system: false,
    paused_by_owner: 'none',
    settings: { group_invite_policy: 'open', inbox_mode: 'open' },
    status: 'active',
    updated_at: '2026-11-17T09:04:00.000Z',
  },
  claim_expires_at: '2026-11-17T09:14:00.000Z',
  claim_expires_in_s: 600,
  claim_url: 'https://app.agentchat.me/claim/acl_example-not-a-real-link',
  connect: CONNECT,
  flow: 'register',
  message: CONNECT_MESSAGE,
  next_step: 'connect',
  status: 'approved',
  version: 1,
}

/** The shape of the result for CONNECT_ANSWER, whatever the composition. */
const CONNECT_RESULT = {
  ok: true,
  message: CONNECT_MESSAGE,
  handle: 'example-relay',
  connect: CONNECT,
  claim_url: 'https://app.agentchat.me/claim/acl_example-not-a-real-link',
  claim_expires_at: '2026-11-17T09:14:00.000Z',
  claim_expires_in_s: 600,
  important:
    'No API key comes with this sign-up: the next step is a connector at connect.mcp_url. That address is single-use: it names this sign-up’s grant, works only exactly as given, and signs in once, until 2026-11-17T10:04:00.000Z (connect.expires_at).',
}

/** What the lost-key texts say; none belongs on a connect answer. */
const LOST_KEY = /recover|key you do not hold|no api_key/i

// The texts are facts, never instructions (as tests/tools/wake-check-handlers.test.ts
// checks for the wake-check tools): no clause opens with a verb addressed to
// the model, and none says what the model should do.
const IMPERATIVE = /(?:^|[.:;,!?—]\s*|\n)(?:give|start|call|replace|clear|remove|read|try|use|set|follow|pass|put|hand|run|stop|check|keep|add|send|open|ask|wait|retry|switch|report|register|recover|store|write|tell)\b/i
const ADVICE = /\byou (?:should|must|need to|have to)\b|\bplease\b|\bmake sure\b|\bbe sure\b|\bdo not\b/i

describe('agentchat_verify_otp: the connect answer of a connector sign-up', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the server’s message, the handle, connect as returned and the claim link, with no key and no lost-key text', async () => {
    const { impl, calls } = fetchStub(() => json(201, CONNECT_ANSWER))
    const result = await verifyOtp.createHandler(makeCtx(impl, null))({ pending_id: 'pnd_example0pending01', code: '123456' })
    expect(result.isError).toBeFalsy()
    const text = firstText(result)
    const payload = JSON.parse(text) as Record<string, unknown>
    expect(payload).toEqual(CONNECT_RESULT)
    expect(Object.keys(payload)).toEqual(Object.keys(CONNECT_RESULT))
    // The address exactly as the server sent it.
    expect((payload['connect'] as Record<string, unknown>)['mcp_url']).toBe(CONNECT.mcp_url)
    expect(payload).not.toHaveProperty('api_key')
    expect(payload).not.toHaveProperty('store_the_key')
    expect(payload).not.toHaveProperty('then')
    expect(text).not.toMatch(LOST_KEY)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/register/verify')
  })

  it('stdio: nothing is saved (no key came), and the answer is the same', async () => {
    const { impl } = fetchStub(() => json(201, CONNECT_ANSWER))
    const saveKey = vi.fn()
    const result = await verifyOtp.createHandler(Object.assign(makeCtx(impl, null), { saveKey }))({ pending_id: 'pnd_example0pending01', code: '123456' })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toEqual(CONNECT_RESULT)
    expect(saveKey).not.toHaveBeenCalled()
  })

  it('every connect block field passes as returned, one this code does not know included; no claim link, no claim fields', async () => {
    const connect = { ...CONNECT, added_later: { kept: true } }
    const { agent: _agent, claim_url: _u, claim_expires_at: _a, claim_expires_in_s: _s, ...rest } = CONNECT_ANSWER
    const { impl } = fetchStub(() => json(201, { ...rest, agent: { handle: 'example-relay' }, connect }))
    const payload = JSON.parse(firstText(await verifyOtp.createHandler(makeCtx(impl, null))({ pending_id: 'pnd_1', code: '123456' }))) as Record<string, unknown>
    expect(payload['connect']).toEqual(connect)
    expect(payload['handle']).toBe('example-relay')
    for (const key of ['claim_url', 'claim_expires_at', 'claim_expires_in_s']) expect(payload).not.toHaveProperty(key)
  })

  it('without connect.expires_at the facts say no time', async () => {
    const { expires_at: _e, ...connect } = CONNECT
    const { impl } = fetchStub(() => json(201, { ...CONNECT_ANSWER, connect }))
    const payload = JSON.parse(firstText(await verifyOtp.createHandler(makeCtx(impl, null))({ pending_id: 'pnd_1', code: '123456' }))) as Record<string, unknown>
    expect(payload['important']).toBe(
      'No API key comes with this sign-up: the next step is a connector at connect.mcp_url. That address is single-use: it names this sign-up’s grant, works only exactly as given, and signs in once.',
    )
  })

  it('the same result through an SDK that throws on the connect answer (agentchatme 1.11 without finish: ConnectorSignupError)', async () => {
    const { impl } = fetchStub(() => json(201, CONNECT_ANSWER))
    vi.spyOn(AgentChatClient, 'verify').mockImplementation(async (pendingId, code, options) => {
      // As the SDK does: one POST, the body read, then the throw.
      const res = await options!.fetch!(`${options!.baseUrl}/v1/register/verify`, {
        method: 'POST',
        body: JSON.stringify({ pending_id: pendingId, code }),
      })
      const body = (await res.json()) as Record<string, unknown>
      throw new AgentChatError({ code: 'CONNECTOR_SIGNUP', message: String(body['message']), details: { next_step: 'connect', status: 'approved' } }, res.status)
    })
    const result = await verifyOtp.createHandler(makeCtx(impl, null))({ pending_id: 'pnd_example0pending01', code: '123456' })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toEqual(CONNECT_RESULT)
  })

  it('a connect answer without connect.mcp_url is malformed: said so, with no key claimed', async () => {
    const { mcp_url: _m, ...noUrl } = CONNECT
    for (const connect of [undefined, null, 'x', {}, noUrl, { ...CONNECT, mcp_url: '' }, { ...CONNECT, mcp_url: 7 }]) {
      const { impl } = fetchStub(() => json(201, { ...CONNECT_ANSWER, connect }))
      const result = await verifyOtp.createHandler(makeCtx(impl, null))({ pending_id: 'pnd_1', code: '123456' })
      const text = firstText(result)
      expect(result.isError, JSON.stringify(connect)).toBe(true)
      expect(text).toBe(`Error: INTERNAL_ERROR\n\n${verifyOtp.CONNECT_ADDRESS_MISSING}`)
      expect(text).not.toContain('key you do not hold')
      expect(text).not.toContain('no api_key')
      expect(text).not.toContain('acg_example-not-a-real-grant')
    }
  })

  it('an ordinary done answer without a key keeps its lost-key text', async () => {
    const { impl } = fetchStub(() => json(201, { agent: { handle: 'new-bot' }, message: 'Email verified.', version: 1, flow: 'register', next_step: 'done', status: 'approved' }))
    const result = await verifyOtp.createHandler(makeCtx(impl, null))({ pending_id: 'pend_9', code: '654321' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain(
      'The server reported success but returned no api_key: the account exists with a key you do not hold (verifying again answers EXPIRED: the registration is used up). Do not register another handle.',
    )
  })

  it('an ordinary done answer with a key is unchanged: the key, no connect', async () => {
    const { impl } = fetchStub(() => json(201, { api_key: 'ac_live_minted', agent: { handle: 'new-bot' }, version: 1, flow: 'register', next_step: 'done', status: 'approved' }))
    const payload = JSON.parse(firstText(await verifyOtp.createHandler(makeCtx(impl, null))({ pending_id: 'pend_9', code: '654321' }))) as Record<string, unknown>
    expect(payload['api_key']).toBe('ac_live_minted')
    expect(payload['important']).toBe(verifyOtp.IMPORTANT)
    expect(payload).not.toHaveProperty('connect')
  })

  it('the texts this tool adds for it are statements of fact', () => {
    const paragraph = verifyOtp.DESCRIPTION.split('\n').find((line) => line.includes('finish "connector"'))
    expect(paragraph).toBe(
      'A sign-up started with finish "connector" (over HTTP; agentchat_register starts none) gives no key: its answer carries the server’s message and connect, whose mcp_url is the single-use address of a connector for the account.',
    )
    const texts: Record<string, string> = {
      DESCRIPTION: paragraph!,
      'connectFacts with a time': verifyOtp.connectFacts('2026-11-17T10:04:00.000Z'),
      'connectFacts without': verifyOtp.connectFacts(undefined),
      CONNECT_ADDRESS_MISSING: verifyOtp.CONNECT_ADDRESS_MISSING,
    }
    for (const [name, text] of Object.entries(texts)) {
      expect(text.match(IMPERATIVE)?.[0] ?? null, name).toBeNull()
      expect(text.match(ADVICE)?.[0] ?? null, name).toBeNull()
    }
    // The guard catches the shapes it is there for.
    for (const text of ['Do not register another handle.', 'If this repeats, report it to support@agentchat.me.', 'Add the connector at connect.mcp_url.', 'Recover its key with the handle and email.']) {
      expect(IMPERATIVE.test(text) || ADVICE.test(text), text).toBe(true)
    }
  })
})

describe('agentchat_set_webhook handler', () => {
  it('rejects a non-https url IN THE INPUT SCHEMA — the contract surface hosts can see', () => {
    // The https-only rule lives in the zod shape (not a hand-rolled handler
    // check), so tools/list advertises it and the MCP layer rejects bad
    // input before the handler — and therefore before any network call.
    const parsed = z
      .object(setWebhook.INPUT_SHAPE)
      .safeParse({ url: 'http://hooks.example/wake', secret: 'shhh' })
    expect(parsed.success).toBe(false)
    const messages = parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.message)
    expect(messages.join('\n')).toContain('https://')

    const good = z
      .object(setWebhook.INPUT_SHAPE)
      .safeParse({ url: 'https://hooks.example/wake', secret: 'shhh-0123456789abcdef' })
    expect(good.success).toBe(true)
  })

  it('PUTs the webhook with Bearer auth and passes the state through', async () => {
    // The server's answer: `{ wake_webhook: <subscription> }`.
    const { impl, calls } = fetchStub(() => json(200, { wake_webhook: { state: 'active' } }))
    const handler = setWebhook.createHandler(makeCtx(impl))
    const result = await handler({
      url: 'https://hooks.example/wake',
      secret: 'shhh',
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toMatchObject({ ok: true, wake_webhook: { state: 'active' } })
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/agents/me/wake-webhook')
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    // The dialect default is materialized client-side so the server sees an
    // explicit choice; prompt is omitted when not given.
    expect(calls[0]!.body).toEqual({ url: 'https://hooks.example/wake', secret: 'shhh', dialect: 'agentchat' })
  })

  it('forwards dialect and prompt, and appends setup guidance to a dialect URL rejection', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, { wake_webhook: { url: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire', dialect: 'claude-code', state: 'active' } }),
    )
    const handler = setWebhook.createHandler(makeCtx(impl))
    const result = await handler({
      url: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire',
      secret: 'routine-token-0123456789abcdef',
      dialect: 'claude-code',
      prompt: 'Act on the AgentChat wake in the routine-fire-payload block.',
    })
    expect(result.isError).toBeFalsy()
    expect(calls[0]!.body).toEqual({
      url: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire',
      secret: 'routine-token-0123456789abcdef',
      dialect: 'claude-code',
      prompt: 'Act on the AgentChat wake in the routine-fire-payload block.',
    })
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload['ok']).toBe(true)
    expect(payload['next']).toContain('agentchat_test_webhook')

    const rejecting = fetchStub(() =>
      json(400, { code: 'INVALID_WAKE_WEBHOOK_URL', message: 'claude-code wakes go to the routine API trigger URL' }),
    )
    const rejected = await setWebhook.createHandler(makeCtx(rejecting.impl))({
      url: 'https://hooks.example/wake',
      secret: 'routine-token-0123456789abcdef',
      dialect: 'claude-code',
    })
    expect(rejected.isError).toBe(true)
    expect(firstText(rejected)).toContain('INVALID_WAKE_WEBHOOK_URL')
    expect(firstText(rejected)).toContain('URL shape the dialect expects')
  })

  it('rewake: sent only when chosen — true and false travel as given, omitted means the server default', async () => {
    for (const rewake of [true, false] as const) {
      const { impl, calls } = fetchStub(() => json(200, { wake_webhook: { state: 'active', rewake } }))
      const result = await setWebhook.createHandler(makeCtx(impl))({
        url: 'https://hooks.example/wake',
        secret: 'shhh-0123456789abcdef',
        rewake,
      })
      expect(result.isError).toBeFalsy()
      expect(calls[0]!.body).toEqual({
        url: 'https://hooks.example/wake',
        secret: 'shhh-0123456789abcdef',
        dialect: 'agentchat',
        rewake,
      })
      // The server's record (rewake included) passes through, with no note.
      const payload = JSON.parse(firstText(result)) as Record<string, unknown>
      expect(payload).toMatchObject({ ok: true, wake_webhook: { rewake } })
      expect(payload).not.toHaveProperty('rewake_note')
    }
    const { impl, calls } = fetchStub(() => json(200, { wake_webhook: { state: 'active' } }))
    await setWebhook.createHandler(makeCtx(impl))({ url: 'https://hooks.example/wake', secret: 'shhh-0123456789abcdef' })
    expect(calls[0]!.body).not.toHaveProperty('rewake')
  })

  it('shows the subscription the server answers under wake_webhook; top-level keys outside it are not passed through (0.5.2)', async () => {
    // No server sends a flat record (PUT answers { wake_webhook } only); before
    // 0.5.2 such keys were spread into the result, now only the envelope is.
    // The wake secret is built at run time: no credential-shaped literal.
    const wakeSecret = ['shhh', 'x'.repeat(16)].join('-')
    const { impl } = fetchStub(() => json(200, { state: 'active', rewake: true, wake_webhook: { state: 'active', rewake: true } }))
    const payload = JSON.parse(
      firstText(await setWebhook.createHandler(makeCtx(impl))({ url: 'https://hooks.example/wake', secret: wakeSecret, rewake: true })),
    ) as Record<string, unknown>
    expect(payload).toEqual({
      ok: true,
      wake_webhook: { state: 'active', rewake: true },
      next: 'Call agentchat_test_webhook now to prove a wake reaches you.',
    })
    // A flat record alone carries no subscription: rewake counts as not echoed.
    const flat = fetchStub(() => json(200, { state: 'active', rewake: true }))
    const flatPayload = JSON.parse(
      firstText(await setWebhook.createHandler(makeCtx(flat.impl))({ url: 'https://hooks.example/wake', secret: wakeSecret, rewake: true })),
    ) as Record<string, unknown>
    expect(flatPayload).toEqual({ ok: true, rewake_note: setWebhook.REWAKE_IGNORED_NOTE, next: 'Call agentchat_test_webhook now to prove a wake reaches you.' })
  })

  it('rewake in the input schema: a plain optional boolean; blanks mean unset, "true"/"false" mean the booleans, false is never blank', () => {
    const shape = z.object(setWebhook.INPUT_SHAPE)
    const base = { url: 'https://hooks.example/wake', secret: 'shhh-0123456789abcdef' }
    const parse = (rewake: unknown) => shape.parse({ ...base, rewake })['rewake']
    expect(parse(true)).toBe(true)
    expect(parse(false)).toBe(false)
    expect(parse('true')).toBe(true)
    expect(parse('false')).toBe(false)
    expect(parse(null)).toBeUndefined()
    expect(parse('')).toBeUndefined()
    expect(parse(undefined)).toBeUndefined()
    expect(shape.parse(base)).not.toHaveProperty('rewake')
    expect(shape.safeParse({ ...base, rewake: 'yes' }).success).toBe(false)
    expect(shape.safeParse({ ...base, rewake: 1 }).success).toBe(false)

    const emitted = z.toJSONSchema(shape, { target: 'draft-7', io: 'input' })
    const props = emitted['properties'] as Record<string, Record<string, unknown>>
    expect(props['rewake']).toMatchObject({ type: 'boolean' })
    expect(emitted['required']).toEqual(['url', 'secret'])
    // One sentence, and no retired word.
    const text = String(props['rewake']!['description'])
    expect(text.split(/(?<=[.!?])\s/).length).toBe(1)
    expect(text).toContain('unanswered')
    expect(text).toContain('false means you are woken for new messages, invites and your defer reminders, but not re-woken for unanswered cards')
  })

  it('rewake sent but the answer does not carry it: one line says this server ignores it', async () => {
    for (const rewake of [true, false] as const) {
      // Today's server: `{ wake_webhook: { … } }` without rewake.
      const { impl } = fetchStub(() => json(200, { wake_webhook: { url: 'https://hooks.example/wake', dialect: 'agentchat', state: 'active' } }))
      const payload = JSON.parse(
        firstText(
          await setWebhook.createHandler(makeCtx(impl))({
            url: 'https://hooks.example/wake',
            secret: 'shhh-0123456789abcdef',
            rewake,
          }),
        ),
      ) as Record<string, unknown>
      expect(payload['rewake_note']).toBe(setWebhook.REWAKE_IGNORED_NOTE)
    }
    // A contract-v1 server echoes it inside wake_webhook: no note.
    const v1 = fetchStub(() => json(200, { wake_webhook: { url: 'https://hooks.example/wake', state: 'active', rewake: true } }))
    const echoed = JSON.parse(
      firstText(
        await setWebhook.createHandler(makeCtx(v1.impl))({
          url: 'https://hooks.example/wake',
          secret: 'shhh-0123456789abcdef',
          rewake: true,
        }),
      ),
    ) as Record<string, unknown>
    expect(echoed).not.toHaveProperty('rewake_note')
    // Not sent: nothing to say.
    const quiet = fetchStub(() => json(200, { wake_webhook: { state: 'active' } }))
    const omitted = JSON.parse(
      firstText(await setWebhook.createHandler(makeCtx(quiet.impl))({ url: 'https://hooks.example/wake', secret: 'shhh-0123456789abcdef' })),
    ) as Record<string, unknown>
    expect(omitted).not.toHaveProperty('rewake_note')
    expect(setWebhook.REWAKE_IGNORED_NOTE.split(/(?<=[.!?])\s/).length).toBe(1)
  })

  it('rejects an unknown dialect in the input schema', () => {
    const parsed = z
      .object(setWebhook.INPUT_SHAPE)
      .safeParse({ url: 'https://hooks.example/wake', secret: 'shhh-0123456789abcdef', dialect: 'telegram' })
    expect(parsed.success).toBe(false)
  })

  it('surfaces the stdio-flavored NOT_REGISTERED when the session has no identity', async () => {
    const { impl, calls } = fetchStub(() => json(200, { state: 'active' }))
    const handler = setWebhook.createHandler(makeCtx(impl, null))
    const result = await handler({
      url: 'https://hooks.example/wake',
      secret: 'shhh',
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('NOT_REGISTERED')
    expect(calls).toHaveLength(0)
  })

  it('passes server errors through faithfully', async () => {
    const { impl } = fetchStub(() =>
      json(422, { code: 'WEBHOOK_UNREACHABLE', message: 'endpoint did not answer the challenge' }),
    )
    const handler = setWebhook.createHandler(makeCtx(impl))
    const result = await handler({
      url: 'https://hooks.example/wake',
      secret: 'shhh',
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('WEBHOOK_UNREACHABLE')
    expect(firstText(result)).toContain('endpoint did not answer the challenge')
  })
})

describe('agentchat_clear_webhook handler', () => {
  it('DELETEs the webhook and tolerates an empty 204 response', async () => {
    const { impl, calls } = fetchStub(() => new Response(null, { status: 204 }))
    const handler = clearWebhook.createHandler(makeCtx(impl))
    const result = await handler({})
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toEqual({ ok: true })
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/agents/me/wake-webhook')
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
  })

  it('passes a JSON state body through when the server reports one', async () => {
    const { impl } = fetchStub(() => json(200, { state: 'none' }))
    const handler = clearWebhook.createHandler(makeCtx(impl))
    const result = await handler({})
    expect(JSON.parse(firstText(result))).toEqual({ ok: true, state: 'none' })
  })

  it('requires an identity, with the composition-appropriate error', async () => {
    const { impl, calls } = fetchStub(() => new Response(null, { status: 204 }))
    const handler = clearWebhook.createHandler(makeCtx(impl, null))
    const result = await handler({})
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('NOT_REGISTERED')
    expect(calls).toHaveLength(0)
  })
})

describe('agentchat_test_webhook handler', () => {
  it('POSTs the test endpoint with Bearer auth and returns the receiver’s answer', async () => {
    const testWake = {
      ok: true,
      dialect: 'claude-code',
      url_host: 'api.anthropic.com',
      status: 200,
      duration_ms: 310,
      error: null,
      delivery_id: '3e9a3c62-6f4c-4a52-9f2f-0a4f4bb0c001',
    }
    const { impl, calls } = fetchStub(() => json(200, { test_wake: testWake }))
    const result = await testWebhook.createHandler(makeCtx(impl))({})
    expect(result.isError).toBeFalsy()
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/agents/me/wake-webhook/test')
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload).toMatchObject({ ok: true, status: 200, dialect: 'claude-code' })
    expect(payload['next']).toContain('agentchat_inbox first')
    expect(payload['next']).not.toContain('agentchat_wait')
  })

  it('returns a per-dialect fix hint when the receiver refused', async () => {
    const { impl } = fetchStub(() =>
      json(200, {
        test_wake: { ok: false, dialect: 'openclaw', url_host: 'gw.example', status: 401, duration_ms: 20, error: 'HTTP 401 Unauthorized', delivery_id: '3e9a3c62-6f4c-4a52-9f2f-0a4f4bb0c001' },
      }),
    )
    const result = await testWebhook.createHandler(makeCtx(impl))({})
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>
    expect(payload['ok']).toBe(false)
    expect(payload['fix']).toContain('hooks.token')
  })

  it('maps a missing subscription to guidance pointing at agentchat_set_webhook', async () => {
    const { impl } = fetchStub(() =>
      json(404, { code: 'WAKE_WEBHOOK_NOT_CONFIGURED', message: 'No wake webhook is registered for this agent.' }),
    )
    const result = await testWebhook.createHandler(makeCtx(impl))({})
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('WAKE_WEBHOOK_NOT_CONFIGURED')
    expect(firstText(result)).toContain('agentchat_set_webhook')
  })
})

describe('agentchat_test_webhook rate-limit guidance', () => {
  it('a 429 keeps the per-hour test cap guidance AND the retry hint', async () => {
    const { impl } = fetchStub(() =>
      json(429, { code: 'RATE_LIMITED', message: 'Too many test wakes' }, { 'retry-after': '1800' }),
    )
    const result = await testWebhook.createHandler(makeCtx(impl))({})
    expect(result.isError).toBe(true)
    const text = firstText(result)
    expect(text).toContain('Error: RATE_LIMITED')
    expect(text).toContain('capped per hour')
    expect(text).not.toContain('60 messages/second')
    expect(text).toContain('Retry after: 1800 seconds')
  })
})
