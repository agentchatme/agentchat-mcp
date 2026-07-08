import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import * as acceptGroupInvite from '../../src/tools/accept-group-invite.js'
import * as createGroup from '../../src/tools/create-group.js'
import * as getGroup from '../../src/tools/get-group.js'
import * as leaveGroup from '../../src/tools/leave-group.js'
import * as listGroupInvites from '../../src/tools/list-group-invites.js'
import * as rejectGroupInvite from '../../src/tools/reject-group-invite.js'
import type { ToolContext } from '../../src/tools/_types.js'

// Same call-shape discipline as handlers.test.ts: stub the SDK, assert the
// exact arguments each handler forwards and the JSON it shapes back.

function makeCtx(client: Partial<AgentChatClient>): ToolContext {
  return {
    client: client as AgentChatClient,
    logger: pino({ level: 'silent' }),
    selfHandle: '@test',
    semaphore: new Semaphore(10),
    inflight: new Set(),
  }
}

function parseJsonContent(result: { content: unknown[] }): unknown {
  const block = (result.content as Array<{ type: string; text: string }>)[0]!
  return JSON.parse(block.text)
}

const GROUP_DETAIL = {
  id: 'grp_1',
  name: 'launch-crew',
  description: null,
  avatar_url: null,
  created_by: 'test',
  settings: { who_can_invite: 'admin' },
  member_count: 1,
  created_at: '2026-07-08T00:00:00Z',
  last_message_at: null,
  members: [{ handle: 'test', display_name: null, role: 'admin', joined_at: '2026-07-08T00:00:00Z' }],
  your_role: 'admin',
}

describe('agentchat_create_group', () => {
  it('strips @ from member handles and reports per-handle invite outcomes', async () => {
    const createGroupMock = vi.fn().mockResolvedValue({
      group: GROUP_DETAIL,
      add_results: [{ handle: 'alice', outcome: 'invited', invite_id: 'inv_1' }],
    })
    const handler = createGroup.createHandler(makeCtx({ createGroup: createGroupMock }))
    const result = await handler({ name: 'launch-crew', member_handles: ['@alice'] })

    expect(createGroupMock).toHaveBeenCalledWith({
      name: 'launch-crew',
      member_handles: ['alice'],
    })
    expect(parseJsonContent(result)).toMatchObject({
      ok: true,
      group_id: 'grp_1',
      your_role: 'admin',
      invites: [{ handle: 'alice', outcome: 'invited' }],
    })
  })

  it('omits optional fields entirely when absent', async () => {
    const createGroupMock = vi
      .fn()
      .mockResolvedValue({ group: GROUP_DETAIL, add_results: [] })
    const handler = createGroup.createHandler(makeCtx({ createGroup: createGroupMock }))
    await handler({ name: 'solo' })
    expect(createGroupMock).toHaveBeenCalledWith({ name: 'solo' })
  })
})

describe('agentchat_get_group', () => {
  it('passes the id through and returns the full detail', async () => {
    const getGroupMock = vi.fn().mockResolvedValue(GROUP_DETAIL)
    const handler = getGroup.createHandler(makeCtx({ getGroup: getGroupMock }))
    const result = await handler({ group_id: 'grp_1' })
    expect(getGroupMock).toHaveBeenCalledWith('grp_1')
    expect(parseJsonContent(result)).toMatchObject({ id: 'grp_1', your_role: 'admin' })
  })
})

describe('agentchat_list_group_invites', () => {
  it('returns count + invites', async () => {
    const invites = [
      {
        id: 'inv_9',
        group_id: 'grp_2',
        group_name: 'ops',
        group_description: null,
        group_avatar_url: null,
        group_member_count: 4,
        inviter_handle: 'san-asst',
        created_at: '2026-07-08T00:00:00Z',
      },
    ]
    const mock = vi.fn().mockResolvedValue(invites)
    const handler = listGroupInvites.createHandler(makeCtx({ listGroupInvites: mock }))
    const result = await handler()
    expect(parseJsonContent(result)).toMatchObject({ count: 1, invites: [{ id: 'inv_9' }] })
  })
})

describe('agentchat_accept_group_invite / reject', () => {
  it('accept joins and reports the room snapshot', async () => {
    const mock = vi.fn().mockResolvedValue({ ...GROUP_DETAIL, member_count: 5, your_role: 'member' })
    const handler = acceptGroupInvite.createHandler(makeCtx({ acceptGroupInvite: mock }))
    const result = await handler({ invite_id: 'inv_9' })
    expect(mock).toHaveBeenCalledWith('inv_9')
    expect(parseJsonContent(result)).toMatchObject({ ok: true, member_count: 5, your_role: 'member' })
  })

  it('reject resolves to a quiet outcome', async () => {
    const mock = vi.fn().mockResolvedValue({ message: 'rejected' })
    const handler = rejectGroupInvite.createHandler(makeCtx({ rejectGroupInvite: mock }))
    const result = await handler({ invite_id: 'inv_9' })
    expect(mock).toHaveBeenCalledWith('inv_9')
    expect(parseJsonContent(result)).toMatchObject({ ok: true, outcome: 'rejected' })
  })
})

describe('agentchat_leave_group', () => {
  it('surfaces the auto-promoted admin', async () => {
    const mock = vi.fn().mockResolvedValue({ message: 'left', promoted_handle: 'aleph-null' })
    const handler = leaveGroup.createHandler(makeCtx({ leaveGroup: mock }))
    const result = await handler({ group_id: 'grp_1' })
    expect(parseJsonContent(result)).toMatchObject({ ok: true, promoted_handle: 'aleph-null' })
  })

  it('maps SDK errors through the shared boundary instead of throwing', async () => {
    const mock = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { code: 'GROUP_DELETED' }))
    const handler = leaveGroup.createHandler(makeCtx({ leaveGroup: mock }))
    const result = await handler({ group_id: 'grp_dead' })
    expect(result.isError).toBe(true)
  })
})
