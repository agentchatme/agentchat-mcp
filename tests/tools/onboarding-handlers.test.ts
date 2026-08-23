import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { NotRegisteredError } from '../../src/client.js'
import { Semaphore } from '../../src/semaphore.js'
import * as clearWebhook from '../../src/tools/clear-webhook.js'
import * as registerAccount from '../../src/tools/register.js'
import * as setWebhook from '../../src/tools/set-webhook.js'
import * as verifyOtp from '../../src/tools/verify-otp.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Onboarding + webhook handler call-shape tests ─────────────────────────
//
// Same discipline as handlers.test.ts, but these tools speak to the API
// through the SDK's HttpTransport with an injected fetch — so the stubs sit
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
    ['EMAIL_TAKEN', 409, /existing API key/],
    ['EMAIL_EXHAUSTED', 429, /different email/],
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
    expect(String(payload['important'])).toContain('AGENTCHAT_API_KEY')

    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/register/verify')
    expect(calls[0]!.body).toEqual({ pending_id: 'pend_9', code: '654321' })
  })

  it('passes expiry errors through with re-register guidance', async () => {
    const { impl } = fetchStub(() =>
      json(400, { code: 'CODE_EXPIRED', message: 'code expired' }),
    )
    const handler = verifyOtp.createHandler(makeCtx(impl, null))
    const result = await handler({ pending_id: 'pend_9', code: '654321' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('CODE_EXPIRED')
    expect(firstText(result)).toContain('agentchat_register')
  })

  it('fails with explicit do-not-re-register guidance when success carries no api_key', async () => {
    const { impl } = fetchStub(() => json(200, { agent: { handle: 'new-bot' } }))
    const handler = verifyOtp.createHandler(makeCtx(impl, null))
    const result = await handler({ pending_id: 'pend_9', code: '654321' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('api_key')
  })
})

describe('agentchat_set_webhook handler', () => {
  it('rejects a non-https url BEFORE any network call', async () => {
    const { impl, calls } = fetchStub(() => json(200, { state: 'active' }))
    const handler = setWebhook.createHandler(makeCtx(impl))
    const result = await handler({
      url: 'http://hooks.example/wake',
      secret: 'shhh',
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('VALIDATION_ERROR')
    expect(firstText(result)).toContain('https')
    expect(calls).toHaveLength(0)
  })

  it('PUTs the webhook with Bearer auth and passes the state through', async () => {
    const { impl, calls } = fetchStub(() => json(200, { state: 'active' }))
    const handler = setWebhook.createHandler(makeCtx(impl))
    const result = await handler({
      url: 'https://hooks.example/wake',
      secret: 'shhh',
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toEqual({ ok: true, state: 'active' })
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.url).toBe('https://api.agentchat.test/v1/agents/me/wake-webhook')
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(calls[0]!.body).toEqual({ url: 'https://hooks.example/wake', secret: 'shhh' })
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
