import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as updateProfile from '../../src/tools/update-profile.js'
import { fetchStub, firstText, json, makeRealCtx, pathOf, payloadOf } from './_real-client.js'

// agentchat_update_profile: PATCH /v1/agents/{own handle}. `bio` is the
// profile's `description`; the two privacy switches and `wake_mode` travel
// under settings (the server merges them: the ones not given stay).

const AGENT = {
  id: 'agt_scout',
  handle: 'scout',
  email: 'scout@example.test',
  display_name: 'Me',
  description: 'I do things',
  avatar_url: null,
  status: 'active',
  paused_by_owner: 'none',
  settings: { inbox_mode: 'open', group_invite_policy: 'open' },
}

describe('agentchat_update_profile', () => {
  it('PATCHes the own handle with only the fields given; bio travels as description, modes under settings', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, { ...AGENT, display_name: 'Scout', description: 'I scout.', settings: { inbox_mode: 'contacts_only', group_invite_policy: 'open' } }),
    )
    const result = await updateProfile.createHandler(makeRealCtx(impl, { selfHandle: '@scout' }))({
      display_name: 'Scout',
      bio: 'I scout.',
      inbox_mode: 'contacts_only',
    })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(pathOf(calls[0]!)).toBe('/v1/agents/scout')
    expect(calls[0]!.body).toEqual({
      display_name: 'Scout',
      description: 'I scout.',
      settings: { inbox_mode: 'contacts_only' },
    })
    expect(payloadOf(result)).toEqual({
      ok: true,
      handle: '@scout',
      updated: ['display_name', 'bio', 'inbox_mode'],
      profile: {
        display_name: 'Scout',
        description: 'I scout.',
        settings: { inbox_mode: 'contacts_only', group_invite_policy: 'open' },
      },
    })
  })

  it('resolves the handle with GET /v1/agents/me first when the session does not know it yet', async () => {
    const { impl, calls } = fetchStub((call) =>
      call.method === 'GET' ? json(200, AGENT) : json(200, { ...AGENT, settings: { inbox_mode: 'open', group_invite_policy: 'contacts_only' } }),
    )
    const result = await updateProfile.createHandler(makeRealCtx(impl, { selfHandle: '?' }))({
      group_invite_policy: 'contacts_only',
    })
    expect(result.isError).toBeFalsy()
    expect(calls.map((c) => [c.method, pathOf(c)])).toEqual([
      ['GET', '/v1/agents/me'],
      ['PATCH', '/v1/agents/scout'],
    ])
    expect(calls[1]!.body).toEqual({ settings: { group_invite_policy: 'contacts_only' } })
    expect(payloadOf(result)).toMatchObject({ handle: '@scout', updated: ['group_invite_policy'] })
  })

  it('wake_mode travels under settings alone, and the server’s merged settings come back', async () => {
    const merged = { inbox_mode: 'open', group_invite_policy: 'open', wake_mode: 'when_run' }
    const { impl, calls } = fetchStub(() => json(200, { ...AGENT, settings: merged }))
    const result = await updateProfile.createHandler(makeRealCtx(impl, { selfHandle: '@scout' }))({ wake_mode: 'when_run' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(pathOf(calls[0]!)).toBe('/v1/agents/scout')
    expect(calls[0]!.body).toEqual({ settings: { wake_mode: 'when_run' } })
    expect(payloadOf(result)).toEqual({
      ok: true,
      handle: '@scout',
      updated: ['wake_mode'],
      profile: { display_name: 'Me', description: 'I do things', settings: merged },
    })
  })

  it('wake_mode beside a privacy switch: both under one settings object', async () => {
    const { impl, calls } = fetchStub(() => json(200, AGENT))
    await updateProfile.createHandler(makeRealCtx(impl, { selfHandle: '@scout' }))({ inbox_mode: 'contacts_only', wake_mode: 'wake' })
    expect(calls[0]!.body).toEqual({ settings: { inbox_mode: 'contacts_only', wake_mode: 'wake' } })
  })

  it('describes wake_mode in one line: when_run means nothing starts you, you read your tray each run, the no-wake notices stop', () => {
    const schema = z.toJSONSchema(z.object(updateProfile.INPUT_SHAPE), { target: 'draft-7', io: 'input' }) as {
      properties: Record<string, { enum?: string[]; description?: string }>
    }
    expect(schema.properties['wake_mode']!.enum).toEqual(['wake', 'when_run'])
    const line = schema.properties['wake_mode']!.description!
    expect(line).not.toContain('\n')
    expect(line).toContain('`when_run` (nothing can start you from outside; you read your tray at the start of every run; it silences the no-wake notices)')
    expect(updateProfile.FIELD_RULE).toContain('wake_mode')
    expect(updateProfile.DESCRIPTION).toContain('`wake_mode`')
  })

  it('refuses an empty update at the schema and in the handler, with zero network calls', async () => {
    expect(updateProfile.INPUT_SCHEMA.safeParse({}).success).toBe(false)
    expect(updateProfile.INPUT_SCHEMA.safeParse({ bio: 'x' }).success).toBe(true)
    const opts = { target: 'draft-7', io: 'input' } as const
    expect(z.toJSONSchema(updateProfile.INPUT_SCHEMA, opts)).toEqual(
      z.toJSONSchema(z.object(updateProfile.INPUT_SHAPE), opts),
    )
    const { impl, calls } = fetchStub(() => json(200, AGENT))
    const result = await updateProfile.createHandler(makeRealCtx(impl, { selfHandle: '@scout' }))({})
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${updateProfile.FIELD_RULE}`)
    expect(calls).toHaveLength(0)
  })

  it('enforces the bounds and enums in the schema', () => {
    const shape = z.object(updateProfile.INPUT_SHAPE)
    expect(shape.safeParse({ display_name: 'x'.repeat(101) }).success).toBe(false)
    expect(shape.safeParse({ bio: 'x'.repeat(501) }).success).toBe(false)
    expect(shape.safeParse({ inbox_mode: 'closed' }).success).toBe(false)
    expect(shape.safeParse({ group_invite_policy: 'nobody' }).success).toBe(false)
    expect(shape.safeParse({ wake_mode: 'never' }).success).toBe(false)
    expect(shape.safeParse({ wake_mode: 'when_run' }).success).toBe(true)
    expect(updateProfile.INPUT_SCHEMA.safeParse({ wake_mode: 'wake' }).success).toBe(true)
    expect(shape.safeParse({ display_name: '' }).success).toBe(true)
  })

  it('403 adds the own-profile guidance', async () => {
    const { impl } = fetchStub(() => json(403, { code: 'FORBIDDEN', message: 'You can only update your own account' }))
    const result = await updateProfile.createHandler(makeRealCtx(impl, { selfHandle: '@scout' }))({ bio: 'x' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: FORBIDDEN')
    expect(firstText(result)).toContain('You can only update your own profile')
  })
})
