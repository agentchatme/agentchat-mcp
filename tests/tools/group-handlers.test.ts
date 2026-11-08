import { createAgentChatError, type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Semaphore } from '../../src/semaphore.js'
import * as createGroup from '../../src/tools/create-group.js'
import * as getGroup from '../../src/tools/get-group.js'
import * as leaveGroup from '../../src/tools/leave-group.js'
import * as listGroupInvites from '../../src/tools/list-group-invites.js'
import * as respondToInvite from '../../src/tools/respond-to-invite.js'
import type { ToolContext } from '../../src/tools/_types.js'

// Same call-shape discipline as handlers.test.ts: stub the SDK, assert the
// exact arguments each handler forwards and the JSON it shapes back.

/** The default network for this file: none. A test that needs the wire passes its own stub. */
const noNetwork = (async () => {
  throw new Error('group-handlers tests never reach the network: pass a fetch stub')
}) as typeof fetch

type FetchCall = { url: string; method: string; headers: Headers; body: unknown }

function fetchStub(
  respond: (call: FetchCall) => Response | Promise<Response>,
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
    return respond(call)
  }) as typeof fetch
  return { impl, calls }
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const TEST_KEY = 'ac_test_0123456789abcdef0123456789abcdef'

function makeCtx(
  client: Partial<AgentChatClient>,
  fetchImpl: typeof fetch = noNetwork,
  apiKey: string | null = TEST_KEY,
): ToolContext {
  return {
    client: client as AgentChatClient,
    logger: pino({ level: 'silent' }),
    selfHandle: '@test',
    semaphore: new Semaphore(10),
    inflight: new Set(),
    rest: {
      apiBase: 'https://api.agentchat.test',
      apiKey,
      fetchImpl,
    },
    turnKey: () => undefined,
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

describe('agentchat_respond_to_invite (accept + decline + dismiss)', () => {
  it('accept joins and reports the room snapshot', async () => {
    const accept = vi.fn().mockResolvedValue({ ...GROUP_DETAIL, member_count: 5, your_role: 'member' })
    const reject = vi.fn()
    const handler = respondToInvite.createHandler(
      makeCtx({ acceptGroupInvite: accept, rejectGroupInvite: reject }),
    )
    const result = await handler({ invite_id: 'inv_9', response: 'accept' })
    expect(accept).toHaveBeenCalledWith('inv_9')
    expect(reject).not.toHaveBeenCalled()
    expect(parseJsonContent(result)).toMatchObject({
      ok: true,
      invite_id: 'inv_9',
      response: 'accept',
      outcome: 'joined',
      group: { group_id: 'grp_1', member_count: 5, your_role: 'member' },
    })
  })

  it('decline resolves to a quiet outcome without touching accept', async () => {
    const accept = vi.fn()
    const reject = vi.fn().mockResolvedValue({ message: 'rejected' })
    const handler = respondToInvite.createHandler(
      makeCtx({ acceptGroupInvite: accept, rejectGroupInvite: reject }),
    )
    const result = await handler({ invite_id: 'inv_9', response: 'decline' })
    expect(reject).toHaveBeenCalledWith('inv_9')
    expect(accept).not.toHaveBeenCalled()
    expect(parseJsonContent(result)).toEqual({
      ok: true,
      invite_id: 'inv_9',
      response: 'decline',
      outcome: 'declined',
    })
  })

  it('the schema admits exactly accept | decline | dismiss', () => {
    const shape = z.object(respondToInvite.INPUT_SHAPE)
    expect(respondToInvite.RESPONSES).toEqual(['accept', 'decline', 'dismiss'])
    expect(shape.safeParse({ invite_id: 'inv_9', response: 'accept' }).success).toBe(true)
    expect(shape.safeParse({ invite_id: 'inv_9', response: 'dismiss' }).success).toBe(true)
    expect(shape.safeParse({ invite_id: 'inv_9', response: 'reject' }).success).toBe(false)
    expect(shape.safeParse({ invite_id: 'inv_9' }).success).toBe(false)
    expect(shape.safeParse({ response: 'accept' }).success).toBe(false)
  })

  it('dismiss: one POST /v1/groups/invites/{id}/dismiss with Bearer auth and an Idempotency-Key; accept and decline untouched', async () => {
    const accept = vi.fn()
    const reject = vi.fn()
    const { impl, calls } = fetchStub(() => json(200, { dismissed: true }))
    const handler = respondToInvite.createHandler(
      makeCtx({ acceptGroupInvite: accept, rejectGroupInvite: reject }, impl),
    )
    const result = await handler({ invite_id: 'inv/9', response: 'dismiss' })
    expect(result.isError).toBeFalsy()
    expect(accept).not.toHaveBeenCalled()
    expect(reject).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(new URL(call.url).pathname).toBe('/v1/groups/invites/inv%2F9/dismiss')
    expect(call.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`)
    expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(call.body).toBeNull()
    expect(parseJsonContent(result)).toEqual({
      ok: true,
      invite_id: 'inv/9',
      response: 'dismiss',
      outcome: 'dismissed',
      next: expect.stringContaining('stays pending and is off your tray'),
    })
  })

  it('dismiss is idempotent: a transient 503 is retried once under the same Idempotency-Key', async () => {
    const { impl, calls } = fetchStub((call) =>
      calls.length === 1
        ? json(503, { code: 'INTERNAL_ERROR', message: 'try again' })
        : json(200, { dismissed: true, call: call.method }),
    )
    const handler = respondToInvite.createHandler(makeCtx({}, impl))
    const result = await handler({ invite_id: 'inv_9', response: 'dismiss' })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'))
  })

  it('dismiss on a server without the endpoint (bare 404) says to accept or decline instead', async () => {
    const { impl } = fetchStub(() => new Response('404 Not Found', { status: 404 }))
    const handler = respondToInvite.createHandler(makeCtx({}, impl))
    const result = await handler({ invite_id: 'inv_9', response: 'dismiss' })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('Error: NOT_FOUND')
    expect(text).toContain('cannot dismiss invites yet: answer it with accept or decline instead')
  })

  it('dismiss without an identity makes no network call', async () => {
    const { impl, calls } = fetchStub(() => json(200, { dismissed: true }))
    const handler = respondToInvite.createHandler(makeCtx({}, impl, null))
    const result = await handler({ invite_id: 'inv_9', response: 'dismiss' })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('NOT_REGISTERED')
    expect(calls).toHaveLength(0)
  })

  it('an answered or unknown invite comes back as INVITE_NOT_FOUND with guidance, for every answer', async () => {
    const gone = () =>
      Promise.reject(createAgentChatError({ code: 'INVITE_NOT_FOUND', message: 'Invite not found' }, 404))
    const { impl } = fetchStub(() => json(404, { code: 'INVITE_NOT_FOUND', message: 'Invite not found' }))
    const handler = respondToInvite.createHandler(
      makeCtx({ acceptGroupInvite: vi.fn(gone), rejectGroupInvite: vi.fn(gone) }, impl),
    )
    for (const response of respondToInvite.RESPONSES) {
      const result = await handler({ invite_id: 'inv_old', response })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0]!.text
      expect(text).toContain('Error: INVITE_NOT_FOUND')
      expect(text).toContain('Invite not found')
      expect(text).toContain('agentchat_list_group_invites')
    }
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
