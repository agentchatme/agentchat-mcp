import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as mute from '../../src/tools/mute.js'
import { fetchStub, firstText, json, KEY, makeRealCtx, pathOf, payloadOf } from './_real-client.js'

// agentchat_mute: target (conversation id or handle) × duration (8h | 1d |
// 3d | forever | off) → POST /v1/mutes or DELETE /v1/mutes/{kind}/{target}.
// Real client over a stubbed network: the exact wire shape and the real
// error pipeline are what is asserted.

const MUTE_ROW = (over: Record<string, unknown>) => ({
  muter_agent_id: 'agt_me',
  target_kind: 'agent',
  target_id: 'agt_alice',
  muted_until: null,
  created_at: '2026-11-04T10:00:00.000Z',
  ...over,
})

describe('agentchat_mute target and duration rules', () => {
  it('classifies conversation ids and handles, and rejects anything else before the network', () => {
    expect(mute.parseTarget('conv_abc123')).toEqual({ kind: 'conversation', id: 'conv_abc123' })
    expect(mute.parseTarget(' grp_Room-1 ')).toEqual({ kind: 'conversation', id: 'grp_Room-1' })
    expect(mute.parseTarget('@Alice')).toEqual({ kind: 'agent', handle: 'alice' })
    expect(mute.parseTarget('research-bot-7')).toEqual({ kind: 'agent', handle: 'research-bot-7' })
    for (const bad of ['@a', 'has_underscore', '-leading', 'msg_1', '', '@alice bob']) {
      expect(mute.parseTarget(bad)).toEqual({ issue: mute.TARGET_RULE })
    }
  })

  it('maps durations to an expiry from now; forever is open-ended', () => {
    const now = Date.parse('2026-11-04T10:00:00.000Z')
    expect(mute.mutedUntilFor('8h', now)).toBe('2026-11-04T18:00:00.000Z')
    expect(mute.mutedUntilFor('1d', now)).toBe('2026-11-05T10:00:00.000Z')
    expect(mute.mutedUntilFor('3d', now)).toBe('2026-11-07T10:00:00.000Z')
    expect(mute.mutedUntilFor('forever', now)).toBeNull()
    expect(mute.DURATIONS).toEqual(['8h', '1d', '3d', 'forever', 'off'])
  })

  it('the schema admits exactly the five durations', () => {
    const shape = z.object(mute.INPUT_SHAPE)
    for (const duration of mute.DURATIONS) {
      expect(shape.safeParse({ target: 'grp_1', duration }).success).toBe(true)
    }
    expect(shape.safeParse({ target: 'grp_1', duration: 'always' }).success).toBe(false)
    expect(shape.safeParse({ target: 'grp_1', duration: '2h' }).success).toBe(false)
    expect(shape.safeParse({ duration: '8h' }).success).toBe(false)
  })
})

describe('agentchat_mute handler', () => {
  it('handle + 8h: POST /v1/mutes with target_handle and an expiry eight hours out', async () => {
    const before = Date.now()
    const { impl, calls } = fetchStub(() =>
      json(201, MUTE_ROW({ muted_until: '2026-11-04T18:00:00.000Z' })),
    )
    const result = await mute.createHandler(makeRealCtx(impl))({ target: '@Alice', duration: '8h' })
    expect(result.isError).toBeFalsy()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(pathOf(calls[0]!)).toBe('/v1/mutes')
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    const body = calls[0]!.body as { target_kind: string; target_handle: string; muted_until: string }
    expect(body.target_kind).toBe('agent')
    expect(body.target_handle).toBe('alice')
    const until = Date.parse(body.muted_until)
    expect(until - before).toBeGreaterThanOrEqual(mute.DURATION_MS['8h'] - 1_000)
    expect(until - before).toBeLessThanOrEqual(mute.DURATION_MS['8h'] + 5_000)

    expect(payloadOf(result)).toMatchObject({
      ok: true,
      target: '@alice',
      target_kind: 'agent',
      muted: true,
      duration: '8h',
      muted_until: '2026-11-04T18:00:00.000Z',
    })
  })

  it('conversation + forever: target_id and muted_until null', async () => {
    const { impl, calls } = fetchStub(() =>
      json(201, MUTE_ROW({ target_kind: 'conversation', target_id: 'grp_1', muted_until: null })),
    )
    const result = await mute.createHandler(makeRealCtx(impl))({ target: 'grp_1', duration: 'forever' })
    expect(calls[0]!.body).toEqual({ target_kind: 'conversation', target_id: 'grp_1', muted_until: null })
    expect(payloadOf(result)).toMatchObject({
      ok: true,
      target: 'grp_1',
      target_kind: 'conversation',
      muted: true,
      muted_until: null,
    })
  })

  it('off: DELETE /v1/mutes/agent/{handle}; a 404 NOT_FOUND means it was already off and still succeeds', async () => {
    const { impl, calls } = fetchStub((_call, index) =>
      index === 0 ? json(200, { ok: true }) : json(404, { code: 'NOT_FOUND', message: 'No active mute for that agent' }),
    )
    const handler = mute.createHandler(makeRealCtx(impl))
    const first = await handler({ target: '@alice', duration: 'off' })
    expect(calls[0]!.method).toBe('DELETE')
    expect(pathOf(calls[0]!)).toBe('/v1/mutes/agent/alice')
    expect(payloadOf(first)).toEqual({
      ok: true,
      target: '@alice',
      target_kind: 'agent',
      muted: false,
      muted_until: null,
      was_muted: true,
    })

    const second = await handler({ target: '@alice', duration: 'off' })
    expect(second.isError).toBeFalsy()
    expect(payloadOf(second)).toMatchObject({ muted: false, was_muted: false })
  })

  it('off on a conversation: DELETE /v1/mutes/conversation/{id}, percent-encoded', async () => {
    const { impl, calls } = fetchStub(() => json(200, { ok: true }))
    await mute.createHandler(makeRealCtx(impl))({ target: 'conv_a-b', duration: 'off' })
    expect(pathOf(calls[0]!)).toBe('/v1/mutes/conversation/conv_a-b')
  })

  it('off on an unknown handle is a real error (AGENT_NOT_FOUND → NOT_FOUND with the handle guidance), not "already off"', async () => {
    const { impl } = fetchStub(() => json(404, { code: 'AGENT_NOT_FOUND', message: 'Account @ghost not found' }))
    const result = await mute.createHandler(makeRealCtx(impl))({ target: '@ghost', duration: 'off' })
    expect(result.isError).toBe(true)
    // The shared mapper folds the SDK's *_NOT_FOUND codes into NOT_FOUND and
    // keeps the tool's guidance, so the model still learns what was missing.
    expect(firstText(result)).toContain('Error: NOT_FOUND')
    expect(firstText(result)).toContain('No agent with that handle is registered')
    expect(firstText(result)).not.toContain('was_muted')
  })

  it('an unknown conversation on mute: NOT_FOUND with the conversation guidance', async () => {
    const { impl } = fetchStub(() =>
      json(404, { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation conv_1 not found' }),
    )
    const result = await mute.createHandler(makeRealCtx(impl))({ target: 'conv_1', duration: '1d' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: NOT_FOUND')
    expect(firstText(result)).toContain('exactly as agentchat_inbox or agentchat_list_conversations gave it')
  })

  it('an invalid target is refused with VALIDATION_ERROR and zero network calls', async () => {
    const { impl, calls } = fetchStub(() => json(201, MUTE_ROW({})))
    const result = await mute.createHandler(makeRealCtx(impl))({ target: 'msg_1', duration: '1d' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${mute.TARGET_RULE}`)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['SELF_MUTE', 400, /mute the conversation instead/],
    ['FORBIDDEN', 403, /participant of/],
  ])('%s keeps the server message and adds guidance', async (code, status, guidance) => {
    const { impl } = fetchStub(() => json(status, { code, message: `server says ${code}` }))
    const target = code === 'SELF_MUTE' ? '@myself' : 'conv_1'
    const result = await mute.createHandler(makeRealCtx(impl))({ target, duration: '1d' })
    expect(result.isError).toBe(true)
    const text = firstText(result)
    expect(text).toContain(`Error: ${code}`)
    expect(text).toContain(`server says ${code}`)
    expect(text).toMatch(guidance)
  })

  it('429 on a mute write carries the retry hint and the mute-specific guidance', async () => {
    const { impl } = fetchStub(() =>
      json(429, { code: 'RATE_LIMITED', message: 'Too many mute writes per second' }, { 'retry-after': '2' }),
    )
    const result = await mute.createHandler(makeRealCtx(impl))({ target: 'grp_1', duration: '3d' })
    expect(result.isError).toBe(true)
    const text = firstText(result)
    expect(text).toContain('Error: RATE_LIMITED')
    expect(text).toContain('Mute writes are capped per second')
    expect(text).toContain('Retry after: 2 seconds')
  })

  it('no identity: NOT_REGISTERED (stdio) / NOT_AUTHENTICATED (hosted) with zero network calls', async () => {
    const { impl, calls } = fetchStub(() => json(201, MUTE_ROW({})))
    const stdio = await mute.createHandler(makeRealCtx(impl, { apiKey: null }))({ target: 'grp_1', duration: '8h' })
    expect(firstText(stdio)).toContain('NOT_REGISTERED')
    const hosted = await mute.createHandler(makeRealCtx(impl, { apiKey: null, mode: 'hosted' }))({
      target: 'grp_1',
      duration: '8h',
    })
    expect(firstText(hosted)).toContain('NOT_AUTHENTICATED')
    expect(calls).toHaveLength(0)
  })
})
