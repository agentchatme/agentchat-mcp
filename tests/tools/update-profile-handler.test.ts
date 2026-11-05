import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as updateProfile from '../../src/tools/update-profile.js'
import { fetchStub, firstText, json, makeRealCtx, pathOf, payloadOf } from './_real-client.js'

// agentchat_update_profile: PATCH /v1/agents/{own handle}. `bio` is the
// profile's `description`; the two privacy switches travel under settings.

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
