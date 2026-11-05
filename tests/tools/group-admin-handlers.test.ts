import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as deleteGroup from '../../src/tools/delete-group.js'
import * as manageMembers from '../../src/tools/manage-members.js'
import * as updateGroup from '../../src/tools/update-group.js'
import { fetchStub, firstText, json, makeRealCtx, pathOf, payloadOf } from './_real-client.js'

// The three admin tools over a real client: agentchat_update_group (PATCH),
// agentchat_manage_members (one action, several handles, per-handle report)
// and agentchat_delete_group (destructive, alone).

const GROUP = {
  id: 'grp_1',
  name: 'ops',
  description: 'operations room',
  avatar_url: null,
  created_by: 'me',
  settings: { who_can_invite: 'admin' },
  member_count: 4,
  created_at: '2026-07-08T00:00:00Z',
  last_message_at: null,
  members: [],
  your_role: 'admin',
}

describe('agentchat_update_group', () => {
  it('PATCHes only the fields given and reports what changed', async () => {
    const { impl, calls } = fetchStub(() => json(200, { ...GROUP, name: 'ops-2' }))
    const result = await updateGroup.createHandler(makeRealCtx(impl))({ group_id: 'grp_1', name: 'ops-2' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(pathOf(calls[0]!)).toBe('/v1/groups/grp_1')
    expect(calls[0]!.body).toEqual({ name: 'ops-2' })
    expect(payloadOf(result)).toEqual({
      ok: true,
      group_id: 'grp_1',
      changed: ['name'],
      name: 'ops-2',
      description: 'operations room',
      member_count: 4,
      your_role: 'admin',
    })
  })

  it('null clears the description and travels as null', async () => {
    const { impl, calls } = fetchStub(() => json(200, { ...GROUP, description: null }))
    const result = await updateGroup.createHandler(makeRealCtx(impl))({ group_id: 'grp_1', description: null })
    expect(calls[0]!.body).toEqual({ description: null })
    expect(payloadOf(result)).toMatchObject({ changed: ['description'], description: null })
  })

  it('refuses an empty change at the schema and in the handler, with zero network calls', async () => {
    expect(updateGroup.INPUT_SCHEMA.safeParse({ group_id: 'grp_1' }).success).toBe(false)
    expect(updateGroup.INPUT_SCHEMA.safeParse({ group_id: 'grp_1', name: 'x' }).success).toBe(true)
    // The refine adds nothing to the wire schema.
    const opts = { target: 'draft-7', io: 'input' } as const
    expect(z.toJSONSchema(updateGroup.INPUT_SCHEMA, opts)).toEqual(
      z.toJSONSchema(z.object(updateGroup.INPUT_SHAPE), opts),
    )
    const { impl, calls } = fetchStub(() => json(200, GROUP))
    const result = await updateGroup.createHandler(makeRealCtx(impl))({ group_id: 'grp_1' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(`Error: VALIDATION_ERROR\n\n${updateGroup.FIELD_RULE}`)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['FORBIDDEN', 403, /Only a group admin/],
    ['GROUP_NOT_FOUND', 404, /not a member, or the id is wrong/],
  ])('%s keeps the server message and adds guidance', async (code, status, guidance) => {
    const { impl } = fetchStub(() => json(status, { code, message: `server says ${code}` }))
    const result = await updateGroup.createHandler(makeRealCtx(impl))({ group_id: 'grp_1', name: 'x' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain(`Error: ${code}`)
    expect(firstText(result)).toContain(`server says ${code}`)
    expect(firstText(result)).toMatch(guidance)
  })
})

describe('agentchat_manage_members', () => {
  it('add: one POST per handle, canonicalized and de-duplicated, with per-handle outcomes', async () => {
    const { impl, calls } = fetchStub((call) => {
      const handle = (call.body as { handle: string }).handle
      return json(201, handle === 'bob' ? { handle, outcome: 'already_member' } : { handle, outcome: 'invited', invite_id: `inv_${handle}` })
    })
    const result = await manageMembers.createHandler(makeRealCtx(impl))({
      group_id: 'grp_1',
      action: 'add',
      handles: ['@Alice', 'bob', 'alice'],
    })
    expect(result.isError).toBeFalsy()
    expect(calls.map((c) => [c.method, pathOf(c), c.body])).toEqual([
      ['POST', '/v1/groups/grp_1/members', { handle: 'alice' }],
      ['POST', '/v1/groups/grp_1/members', { handle: 'bob' }],
    ])
    expect(payloadOf(result)).toEqual({
      ok: true,
      group_id: 'grp_1',
      action: 'add',
      succeeded: 2,
      failed: 0,
      results: [
        { handle: '@alice', ok: true, outcome: 'invited', invite_id: 'inv_alice' },
        { handle: '@bob', ok: true, outcome: 'already_member' },
      ],
      note: 'Invited agents become members only when they accept.',
    })
  })

  it('a partial failure is reported per handle, with the code and guidance, and ok:false overall', async () => {
    const { impl } = fetchStub((call) =>
      (call.body as { handle: string }).handle === 'carol'
        ? json(403, { code: 'INBOX_RESTRICTED', message: 'contacts only' })
        : json(201, { handle: 'alice', outcome: 'invited', invite_id: 'inv_1' }),
    )
    const result = await manageMembers.createHandler(makeRealCtx(impl))({
      group_id: 'grp_1',
      action: 'add',
      handles: ['alice', 'carol'],
    })
    expect(result.isError).toBeFalsy()
    const payload = payloadOf(result) as { ok: boolean; failed: number; results: Array<Record<string, unknown>> }
    expect(payload.ok).toBe(false)
    expect(payload.failed).toBe(1)
    expect(payload.results[0]).toMatchObject({ handle: '@alice', ok: true })
    expect(payload.results[1]).toMatchObject({
      handle: '@carol',
      ok: false,
      error: { code: 'INBOX_RESTRICTED' },
    })
    expect(String((payload.results[1]!['error'] as { message: string }).message)).toContain('contacts only')
    expect(String((payload.results[1]!['error'] as { message: string }).message)).toContain(
      'only accepts group invites from their contacts',
    )
  })

  it('when every handle fails the same way, that reason is the tool error (nothing happened)', async () => {
    const { impl, calls } = fetchStub(() => json(403, { code: 'FORBIDDEN', message: 'Admin only' }))
    const result = await manageMembers.createHandler(makeRealCtx(impl))({
      group_id: 'grp_1',
      action: 'promote',
      handles: ['alice', 'bob'],
    })
    expect(calls).toHaveLength(2)
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: FORBIDDEN')
    expect(firstText(result)).toContain('Admin only')
    expect(firstText(result)).toContain('Only an admin can manage members')
  })

  it('remove / promote / demote hit their endpoints with the handle in the path', async () => {
    const { impl, calls } = fetchStub(() => json(200, { message: 'ok' }))
    const handler = manageMembers.createHandler(makeRealCtx(impl))
    const removed = await handler({ group_id: 'grp_1', action: 'remove', handles: ['@alice'] })
    const promoted = await handler({ group_id: 'grp_1', action: 'promote', handles: ['bob'] })
    const demoted = await handler({ group_id: 'grp_1', action: 'demote', handles: ['bob'] })
    expect(calls.map((c) => [c.method, pathOf(c)])).toEqual([
      ['DELETE', '/v1/groups/grp_1/members/alice'],
      ['POST', '/v1/groups/grp_1/members/bob/promote'],
      ['POST', '/v1/groups/grp_1/members/bob/demote'],
    ])
    expect(payloadOf(removed)).toMatchObject({ results: [{ handle: '@alice', ok: true, outcome: 'removed' }] })
    expect(payloadOf(promoted)).toMatchObject({ results: [{ handle: '@bob', ok: true, outcome: 'promoted' }] })
    expect(payloadOf(demoted)).toMatchObject({ results: [{ handle: '@bob', ok: true, outcome: 'demoted' }] })
  })

  it.each([
    ['NOT_MEMBER', 404, 'remove', /not an active member/],
    ['LAST_ADMIN', 400, 'demote', /Promote someone else/],
    ['NOT_ADMIN', 400, 'demote', /nothing to demote/],
  ])('%s guidance reaches the per-handle error', async (code, status, action, guidance) => {
    const { impl } = fetchStub(() => json(status, { code, message: `server says ${code}` }))
    const result = await manageMembers.createHandler(makeRealCtx(impl))({
      group_id: 'grp_1',
      action: action as manageMembers.Action,
      handles: ['alice'],
    })
    // One handle, one failure: surfaced as the tool error with the guidance.
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain(`Error: ${code}`)
    expect(firstText(result)).toMatch(guidance)
  })

  it('the schema requires 1–50 handles and one of the four actions', () => {
    const shape = z.object(manageMembers.INPUT_SHAPE)
    expect(manageMembers.ACTIONS).toEqual(['add', 'remove', 'promote', 'demote'])
    expect(shape.safeParse({ group_id: 'grp_1', action: 'add', handles: [] }).success).toBe(false)
    expect(shape.safeParse({ group_id: 'grp_1', action: 'kick', handles: ['a'] }).success).toBe(false)
    expect(
      shape.safeParse({ group_id: 'grp_1', action: 'add', handles: Array.from({ length: 51 }, (_, i) => `h${i}`) })
        .success,
    ).toBe(false)
    expect(shape.safeParse({ group_id: 'grp_1', action: 'add', handles: ['alice'] }).success).toBe(true)
  })
})

describe('agentchat_delete_group', () => {
  it('DELETEs the group and reports deleted_at', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, { message: 'Group deleted', deleted_at: '2026-11-04T10:00:00.000Z' }),
    )
    const result = await deleteGroup.createHandler(makeRealCtx(impl))({ group_id: 'grp_1' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('DELETE')
    expect(pathOf(calls[0]!)).toBe('/v1/groups/grp_1')
    expect(payloadOf(result)).toEqual({ ok: true, group_id: 'grp_1', deleted_at: '2026-11-04T10:00:00.000Z' })
  })

  it('403: only the creator may delete; the guidance points at leave_group', async () => {
    const { impl } = fetchStub(() => json(403, { code: 'FORBIDDEN', message: 'Creator only' }))
    const result = await deleteGroup.createHandler(makeRealCtx(impl))({ group_id: 'grp_1' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: FORBIDDEN')
    expect(firstText(result)).toContain('agentchat_leave_group removes just you')
  })

  it('410: an already-deleted group maps to GROUP_DELETED', async () => {
    const { impl } = fetchStub(() =>
      json(410, { code: 'GROUP_DELETED', message: 'Group has been deleted', details: { deleted_by_handle: 'me' } }),
    )
    const result = await deleteGroup.createHandler(makeRealCtx(impl))({ group_id: 'grp_1' })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: GROUP_DELETED')
  })
})
