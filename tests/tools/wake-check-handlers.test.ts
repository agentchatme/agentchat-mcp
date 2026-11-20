import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { AgentChatClient, ServerError } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DESTRUCTIVE, WRITE_IDEMPOTENT } from '../../src/tools/_annotations.js'
import { wakeCheckOf } from '../../src/tools/_wake-check-sdk.js'
import type { ToolContext } from '../../src/tools/_types.js'
import * as clearWakeCheck from '../../src/tools/clear-wake-check.js'
import * as setWakeCheck from '../../src/tools/set-wake-check.js'
import * as setWebhook from '../../src/tools/set-webhook.js'
import { API_BASE, fetchStub, firstText, json, KEY, makeRealCtx, payloadOf } from './_real-client.js'
import './_wake-check-sdk-polyfill.js'

// ─── The wake-check tools, over a real SDK client and a stubbed network ────
//
// Same discipline as the other handler suites: fetch is stubbed under a real
// client, so each test proves the wire (method, path, body, key) and the real
// error pipeline. The SDK's `client.wakeCheck` resource comes from the
// installed SDK when it has one, and from the test stand-in until then
// (_wake-check-sdk-polyfill.ts).

const PATH = `${API_BASE}/v1/agents/me/wake-check`
// An address shaped like the server's (wc1.<kid>.<iv>.<ciphertext>.<tag>),
// built at run time: test code never holds a credential-shaped literal.
const part = (bytes: number) => randomBytes(bytes).toString('base64url')
const CHECK_TOKEN = `wc1.${randomBytes(4).toString('hex')}.${part(12)}.${part(24)}.${part(16)}`
const ADDRESS = `https://api.agentchat.test/v1/wake-check/${CHECK_TOKEN}`
const STATUS = {
  url: ADDRESS,
  rewake: true,
  created_at: '2026-11-20T10:00:00.000Z',
  last_seen_at: null,
}

const empty = (status: number) => new Response(null, { status })

describe('client.wakeCheck: the SDK’s wire (the stand-in until the SDK ships it)', () => {
  const client = (impl: typeof fetch) =>
    new AgentChatClient({ apiKey: KEY, baseUrl: API_BASE, fetch: impl, retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 } })

  it('set: PUT with only the documented fields, the envelope unwrapped; clear: DELETE, the answer as it came', async () => {
    const { impl, calls } = fetchStub((call) =>
      call.method === 'PUT' ? json(200, { wake_check: STATUS }) : json(200, { cleared: true }),
    )
    const wakeCheck = wakeCheckOf(client(impl))
    await expect(wakeCheck.set()).resolves.toEqual(STATUS)
    await expect(wakeCheck.set({ rewake: false, rotate: true })).resolves.toEqual(STATUS)
    await expect(wakeCheck.clear()).resolves.toEqual({ cleared: true })
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['PUT', PATH, {}],
      ['PUT', PATH, { rewake: false, rotate: true }],
      ['DELETE', PATH, null],
    ])
  })

  it('a 503 WAKE_CHECK_UNAVAILABLE is a ServerError (503) after one attempt; any other 503 is retried', async () => {
    const terminal = fetchStub(() => json(503, { code: 'WAKE_CHECK_UNAVAILABLE', message: 'not here' }))
    const err = await wakeCheckOf(client(terminal.impl)).set().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(err).toMatchObject({ code: 'WAKE_CHECK_UNAVAILABLE', status: 503, message: 'not here' })
    expect(terminal.calls).toHaveLength(1)

    const transient = fetchStub(() => json(503, { code: 'INTERNAL_ERROR', message: 'down' }))
    const busy = await wakeCheckOf(client(transient.impl)).set().catch((e: unknown) => e)
    expect(busy).toMatchObject({ code: 'INTERNAL_ERROR', status: 503 })
    expect(transient.calls).toHaveLength(4)
  })
})

describe('agentchat_set_wake_check handler', () => {
  it('PUTs /v1/agents/me/wake-check with the key, sends no field the caller did not choose, and returns the address', async () => {
    const { impl, calls } = fetchStub(() => json(200, { wake_check: STATUS }))
    const result = await setWakeCheck.createHandler(makeRealCtx(impl))({})
    expect(result.isError).toBeFalsy()
    expect(payloadOf(result)).toEqual({ ok: true, wake_check: STATUS, next: setWakeCheck.NEXT })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.url).toBe(PATH)
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(calls[0]!.body).toEqual({})
  })

  it('sends rewake and rotate exactly as chosen; a rotate says the earlier address is gone', async () => {
    const cases: Array<[setWakeCheck.Input, Record<string, unknown>]> = [
      [{ rewake: false }, { rewake: false }],
      [{ rewake: true }, { rewake: true }],
      [{ rotate: false }, { rotate: false }],
      [{ rotate: true }, { rotate: true }],
      [{ rewake: false, rotate: true }, { rewake: false, rotate: true }],
    ]
    for (const [input, body] of cases) {
      const { impl, calls } = fetchStub(() => json(200, { wake_check: { ...STATUS, rewake: input.rewake ?? true } }))
      const payload = payloadOf(await setWakeCheck.createHandler(makeRealCtx(impl))(input))
      expect(calls[0]!.body, JSON.stringify(input)).toEqual(body)
      expect(payload['next'], JSON.stringify(input)).toBe(
        input.rotate === true ? `${setWakeCheck.ROTATED} ${setWakeCheck.NEXT}` : setWakeCheck.NEXT,
      )
    }
  })

  it('passes the server’s answer through as it came, fields this package does not know included', async () => {
    const answer = { ...STATUS, last_seen_at: '2026-11-20T10:05:00.000Z', seq: '1795127996068' }
    const { impl } = fetchStub(() => json(200, { wake_check: answer }))
    expect(payloadOf(await setWakeCheck.createHandler(makeRealCtx(impl))({}))['wake_check']).toEqual(answer)
  })

  it('input schema: two optional booleans; blanks mean unset, "true"/"false" the booleans; rewake is agentchat_set_webhook’s parameter', () => {
    const shape = z.object(setWakeCheck.INPUT_SHAPE)
    for (const name of ['rewake', 'rotate'] as const) {
      const parse = (value: unknown) => shape.parse({ [name]: value })[name]
      expect(parse(true)).toBe(true)
      expect(parse(false)).toBe(false)
      expect(parse('true')).toBe(true)
      expect(parse('false')).toBe(false)
      expect(parse(null)).toBeUndefined()
      expect(parse('')).toBeUndefined()
      expect(shape.safeParse({ [name]: 'yes' }).success).toBe(false)
      expect(shape.safeParse({ [name]: 1 }).success).toBe(false)
    }
    expect(shape.parse({})).toEqual({})

    const emitted = z.toJSONSchema(shape, { target: 'draft-7', io: 'input' })
    const props = emitted['properties'] as Record<string, Record<string, unknown>>
    expect(Object.keys(props).sort()).toEqual(['rewake', 'rotate'])
    expect(emitted['required'] ?? []).toEqual([])
    expect(props['rotate']).toMatchObject({ type: 'boolean' })
    const webhook = z.toJSONSchema(z.object(setWebhook.INPUT_SHAPE), { target: 'draft-7', io: 'input' })
    expect(props['rewake']).toEqual((webhook['properties'] as Record<string, unknown>)['rewake'])
    // The rotate text says a rotate is a new address, in one sentence.
    const rotate = String(props['rotate']!['description'])
    expect(rotate.split(/(?<=[.!?])\s/).length).toBe(1)
    expect(rotate).toContain('issues a new address, and the old one stops working')
  })

  it('409 WAKE_DESTINATION_EXISTS (the agent has a wake webhook): the server’s message and how to switch, one attempt', async () => {
    const message = 'This agent has a wake webhook. Clear it first (DELETE /v1/agents/me/wake-webhook).'
    const { impl, calls } = fetchStub(() => json(409, { code: 'WAKE_DESTINATION_EXISTS', message }))
    const result = await setWakeCheck.createHandler(makeRealCtx(impl))({})
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(
      `Error: WAKE_DESTINATION_EXISTS\n\n${message} ${setWakeCheck.DESTINATION_EXISTS_GUIDANCE}`,
    )
    expect(setWakeCheck.DESTINATION_EXISTS_GUIDANCE).toContain('agentchat_clear_webhook')
    expect(calls).toHaveLength(1)
  })

  it('503 WAKE_CHECK_UNAVAILABLE keeps its code — never a transient SERVER_ERROR — says nothing was changed, and is one attempt', async () => {
    const message = 'Wake checks cannot be issued on this server.'
    const { impl, calls } = fetchStub(() => json(503, { code: 'WAKE_CHECK_UNAVAILABLE', message }))
    const result = await setWakeCheck.createHandler(makeRealCtx(impl))({})
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(`Error: WAKE_CHECK_UNAVAILABLE\n\n${message} ${setWakeCheck.UNAVAILABLE_GUIDANCE}`)
    // The SDK never retries it: the server cannot run wake checks at all.
    expect(calls).toHaveLength(1)
    expect([calls[0]!.method, calls[0]!.url]).toEqual(['PUT', PATH])
  })

  it('a transient 503 is still retried under the PUT’s retry policy', async () => {
    const { impl, calls } = fetchStub((_call, index) =>
      index === 0 ? json(503, { code: 'INTERNAL_ERROR', message: 'blip' }) : json(200, { wake_check: STATUS }),
    )
    const result = await setWakeCheck.createHandler(makeRealCtx(impl))({ rotate: true })
    expect(payloadOf(result)).toMatchObject({ ok: true, wake_check: STATUS })
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['PUT', PATH, { rotate: true }],
      ['PUT', PATH, { rotate: true }],
    ])
  })

  it('a 404 — the server has the wake check switched off (NOT_FOUND) or predates it (bare 404) — says it is not offered and nothing changed', async () => {
    for (const answer of [() => json(404, { code: 'NOT_FOUND', message: 'Not found' }), () => empty(404)]) {
      const { impl, calls } = fetchStub(answer)
      const result = await setWakeCheck.createHandler(makeRealCtx(impl))({ rotate: true })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toBe(`Error: NOT_FOUND\n\n${setWakeCheck.NOT_OFFERED}`)
      expect(calls).toHaveLength(1)
    }
  })

  it('429 RATE_LIMITED: the general mapping, with its retry hint', async () => {
    const { impl } = fetchStub(() => json(429, { code: 'RATE_LIMITED', message: 'slow down' }, { 'retry-after': '60' }))
    const text = firstText(await setWakeCheck.createHandler(makeRealCtx(impl))({}))
    expect(text.startsWith('Error: RATE_LIMITED')).toBe(true)
    expect(text).toContain('Retry after: 60 seconds.')
  })

  it('a 2xx without an address fails closed: the model is never told it is set up with nothing to hand its poller', async () => {
    const answers = [
      () => empty(200),
      () => json(200, null),
      () => json(200, { ok: true }),
      () => json(200, { wake_check: null }),
      () => json(200, { wake_check: { ...STATUS, url: '' } }),
      () => json(200, { wake_check: { ...STATUS, url: 42 } }),
    ]
    for (const [index, answer] of answers.entries()) {
      const { impl } = fetchStub(answer)
      const result = await setWakeCheck.createHandler(makeRealCtx(impl))({})
      expect(result.isError, `answer ${index}`).toBe(true)
      expect(firstText(result), `answer ${index}`).toBe(`Error: INTERNAL_ERROR\n\n${setWakeCheck.ADDRESS_MISSING}`)
    }
  })

  it('no identity: the composition’s own error, and nothing is sent', async () => {
    for (const [mode, code] of [['stdio', 'NOT_REGISTERED'], ['hosted', 'NOT_AUTHENTICATED']] as const) {
      const { impl, calls } = fetchStub(() => json(200, { wake_check: STATUS }))
      const result = await setWakeCheck.createHandler(makeRealCtx(impl, { apiKey: null, mode }))({ rotate: true })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toContain(code)
      expect(calls).toHaveLength(0)
    }
  })

  it('never logs the address, on success or failure (it is a per-agent capability)', async () => {
    const lines: string[] = []
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString())
        done()
      },
    })
    const answers = [
      () => json(200, { wake_check: STATUS }),
      () => json(409, { code: 'WAKE_DESTINATION_EXISTS', message: 'exists' }),
    ]
    for (const answer of answers) {
      const { impl } = fetchStub(answer)
      const ctx: ToolContext = { ...makeRealCtx(impl), logger: pino({ level: 'debug' }, sink) }
      await setWakeCheck.createHandler(ctx)({ rewake: true, rotate: true })
    }
    const logged = lines.join('')
    // The boundary did log: the invocation (with the arguments) and the failure.
    expect(logged).toContain('"tool":"agentchat_set_wake_check"')
    expect(logged).toContain('"rotate":true')
    expect(logged).toContain('tool failed')
    expect(logged).not.toContain(CHECK_TOKEN)
    expect(logged).not.toContain('/v1/wake-check/')
  })

  it('description: who it is for, that the address is not a secret key, what a wake starts, and what a rotate does', () => {
    const text = setWakeCheck.DESCRIPTION
    expect(text).toContain('for runtimes whose pollers cannot hold an API key')
    expect(text).toContain('hook or poller calls with no key')
    expect(text).toContain('The address is not a secret key: it can only say that something is waiting')
    expect(text).toContain('On wake:true, start a run that calls agentchat_inbox first')
    expect(text).toContain('rotate:true issues a new address and the old one stops working')
    expect(text).toContain('agentchat_clear_webhook')
    expect(text).toContain('agentchat_clear_wake_check')
    expect(text.length).toBeLessThanOrEqual(800)
    expect(setWakeCheck.ANNOTATIONS).toEqual(WRITE_IDEMPOTENT)
  })
})

describe('agentchat_clear_wake_check handler', () => {
  it('DELETEs /v1/agents/me/wake-check with the key; when one was removed, says to take the address out of the poller', async () => {
    const { impl, calls } = fetchStub(() => json(200, { cleared: true }))
    const result = await clearWakeCheck.createHandler(makeRealCtx(impl))({})
    expect(result.isError).toBeFalsy()
    expect(payloadOf(result)).toEqual({ ok: true, cleared: true, next: clearWakeCheck.CLEARED_NEXT })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe(PATH)
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
  })

  it('nothing to clear is a success (cleared: false), with nothing more to do', async () => {
    const { impl } = fetchStub(() => json(200, { cleared: false }))
    expect(payloadOf(await clearWakeCheck.createHandler(makeRealCtx(impl))({}))).toEqual({ ok: true, cleared: false })
  })

  it('an empty 2xx reports nothing beyond ok', async () => {
    const { impl } = fetchStub(() => empty(204))
    expect(payloadOf(await clearWakeCheck.createHandler(makeRealCtx(impl))({}))).toEqual({ ok: true })
  })

  it('a 404 (switched off, or a server without the route) says it is not offered and nothing changed', async () => {
    for (const answer of [() => json(404, { code: 'NOT_FOUND', message: 'Not found' }), () => empty(404)]) {
      const { impl } = fetchStub(answer)
      const result = await clearWakeCheck.createHandler(makeRealCtx(impl))({})
      expect(result.isError).toBe(true)
      expect(firstText(result)).toBe(`Error: NOT_FOUND\n\n${clearWakeCheck.NOT_OFFERED}`)
    }
  })

  it('no identity: the composition’s own error, and nothing is sent', async () => {
    const { impl, calls } = fetchStub(() => json(200, { cleared: true }))
    const result = await clearWakeCheck.createHandler(makeRealCtx(impl, { apiKey: null }))({})
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('NOT_REGISTERED')
    expect(calls).toHaveLength(0)
  })

  it('is destructive and idempotent: a cleared address is gone for good, and a repeat changes nothing more', () => {
    expect(clearWakeCheck.ANNOTATIONS).toEqual(DESTRUCTIVE)
    expect(clearWakeCheck.DESCRIPTION).toContain('its address stops working at once')
    expect(clearWakeCheck.DESCRIPTION).toContain('Setting one again gives a new address')
  })
})

describe('agentchat_set_webhook while a wake check is set', () => {
  it('409 WAKE_DESTINATION_EXISTS: the server’s message and how to switch to a webhook', async () => {
    const message = 'This agent has a wake check. Clear it first (DELETE /v1/agents/me/wake-check).'
    const { impl, calls } = fetchStub(() => json(409, { code: 'WAKE_DESTINATION_EXISTS', message }))
    const result = await setWebhook.createHandler(makeRealCtx(impl))({
      url: 'https://hooks.example/wake',
      secret: 'x'.repeat(20),
    })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(
      `Error: WAKE_DESTINATION_EXISTS\n\n${message} An agent has one wake destination: to switch to a webhook, clear the wake check with agentchat_clear_wake_check, then call agentchat_set_webhook again.`,
    )
    expect(calls).toHaveLength(1)
  })
})
