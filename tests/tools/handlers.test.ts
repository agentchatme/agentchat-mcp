import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import * as addContact from '../../src/tools/add-contact.js'
import * as blockAgent from '../../src/tools/block-agent.js'
import * as getAgentProfile from '../../src/tools/get-agent-profile.js'
import * as getConversation from '../../src/tools/get-conversation.js'
import * as getMyStatus from '../../src/tools/get-my-status.js'
import * as listContacts from '../../src/tools/list-contacts.js'
import * as listInbox from '../../src/tools/list-inbox.js'
import * as markRead from '../../src/tools/mark-read.js'
import * as removeContact from '../../src/tools/remove-contact.js'
import * as reportAgent from '../../src/tools/report-agent.js'
import * as sendMessage from '../../src/tools/send-message.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Tool handler call-shape tests ─────────────────────────────────────────
//
// These tests verify each tool's handler calls the underlying SDK method
// with the right arguments, and shapes the response into the expected
// MCP CallToolResult. They do NOT exercise the actual network — the SDK
// is fully stubbed via vi.fn().
//
// The bug these tests catch: a refactor that changes the arg shape of a
// SDK call (e.g. type:'text' vs type inside content) silently passes
// type-check but breaks the wire. The earlier 0.1.0 build had exactly
// that bug fixed during type-check, but no test caught it — these tests
// would.

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

describe('agentchat_send_message', () => {
  afterEach(() => {
    delete process.env['AGENTCHAT_TURN_IDEMPOTENCY_KEY']
  })

  it('forwards to + type:text + content.text + metadata.reply_to to sendMessage', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: {
        id: 'msg_1',
        conversation_id: 'conv_1',
        seq: 42,
        created_at: '2026-05-07T00:00:00Z',
      },
    })
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )
    const result = await handler({ to: '@bob', text: 'hi', reply_to: 'msg_0' })

    expect(sendMessageMock).toHaveBeenCalledWith({
      to: '@bob',
      type: 'text',
      content: { text: 'hi' },
      metadata: { reply_to: 'msg_0' },
    })
    expect(result.isError).toBeFalsy()
    expect(parseJsonContent(result)).toMatchObject({
      ok: true,
      message_id: 'msg_1',
      conversation_id: 'conv_1',
      seq: 42,
    })
  })

  it('routes grp_… targets as conversation_id — `to` is handle-only on the wire', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: {
        id: 'msg_2',
        conversation_id: 'grp_team',
        seq: 7,
        created_at: '2026-07-13T00:00:00Z',
      },
    })
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )
    const result = await handler({ to: 'grp_team', text: 'hello group' })

    expect(sendMessageMock).toHaveBeenCalledWith({
      conversation_id: 'grp_team',
      type: 'text',
      content: { text: 'hello group' },
    })
    expect(sendMessageMock.mock.calls[0]![0]).not.toHaveProperty('to')
    expect(result.isError).toBeFalsy()
  })

  it('routes conv_… targets as conversation_id too, so the server can answer with its specific use-`to` 400', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: {
        id: 'msg_3',
        conversation_id: 'conv_direct',
        seq: 1,
        created_at: '2026-07-13T00:00:00Z',
      },
    })
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )
    await handler({ to: 'conv_direct', text: 'hi' })

    expect(sendMessageMock).toHaveBeenCalledWith({
      conversation_id: 'conv_direct',
      type: 'text',
      content: { text: 'hi' },
    })
  })

  it('omits metadata entirely when reply_to is not provided', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: { id: 'msg_1', conversation_id: 'conv_1', seq: 1, created_at: 'now' },
    })
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )
    await handler({ to: '@bob', text: 'hi' })
    const callArgs = sendMessageMock.mock.calls[0]![0] as Record<string, unknown>
    expect(callArgs).not.toHaveProperty('metadata')
  })

  it('forwards message text without inspecting or censoring its content', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: { id: 'msg_1', conversation_id: 'conv_1', seq: 1, created_at: 'now' },
    })
    const text = `credential-shaped test data: ac_live_${'a'.repeat(32)}`
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )

    const result = await handler({ to: '@bob', text })

    expect(result.isError).toBeFalsy()
    expect(sendMessageMock).toHaveBeenCalledWith({
      to: '@bob',
      type: 'text',
      content: { text },
    })
  })

  it('surfaces backlog warning in the JSON payload when present', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: { id: 'msg_1', conversation_id: 'conv_1', seq: 1, created_at: 'now' },
      backlogWarning: { undelivered_count: 8500 },
    })
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )
    const result = await handler({ to: '@bob', text: 'hi' })
    expect(parseJsonContent(result)).toMatchObject({
      ok: true,
      backlog_warning: { undelivered_count: 8500 },
    })
  })

  it('uses a stable client_msg_id for an always-on retry turn', async () => {
    process.env['AGENTCHAT_TURN_IDEMPOTENCY_KEY'] = 'turn-key-1'
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: { id: 'msg_1', conversation_id: 'conv_1', seq: 1, created_at: 'now' },
    })
    const firstAttempt = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )

    await firstAttempt({ to: '@bob', text: 'first wording', reply_to: 'msg_inbound' })
    // A daemon retry starts a fresh MCP process/handler.
    const replayAttempt = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )
    await replayAttempt({ to: '@bob', text: 'different retry wording', reply_to: 'msg_inbound' })

    const first = sendMessageMock.mock.calls[0]![0] as Record<string, unknown>
    const second = sendMessageMock.mock.calls[1]![0] as Record<string, unknown>
    expect(first['client_msg_id']).toMatch(/^ac_turn_[0-9a-f]{64}$/)
    expect(second['client_msg_id']).toBe(first['client_msg_id'])
  })

  it('keeps two intentional same-recipient sends in one turn distinct', async () => {
    process.env['AGENTCHAT_TURN_IDEMPOTENCY_KEY'] = 'turn-key-1'
    const sendMessageMock = vi.fn().mockResolvedValue({
      message: { id: 'msg_1', conversation_id: 'conv_1', seq: 1, created_at: 'now' },
    })
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )

    await handler({ to: '@bob', text: 'part one' })
    await handler({ to: '@bob', text: 'part two' })

    const first = sendMessageMock.mock.calls[0]![0] as Record<string, unknown>
    const second = sendMessageMock.mock.calls[1]![0] as Record<string, unknown>
    expect(second['client_msg_id']).not.toBe(first['client_msg_id'])
  })

  it('reuses the same client_msg_id after an ambiguous send failure', async () => {
    process.env['AGENTCHAT_TURN_IDEMPOTENCY_KEY'] = 'turn-key-1'
    const sendMessageMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection closed after request'))
      .mockResolvedValueOnce({
        message: { id: 'msg_1', conversation_id: 'conv_1', seq: 1, created_at: 'now' },
      })
    const handler = sendMessage.createHandler(
      makeCtx({ sendMessage: sendMessageMock }),
    )

    const failed = await handler({ to: '@bob', text: 'first wording' })
    const retried = await handler({ to: '@bob', text: 'retry wording' })

    expect(failed.isError).toBe(true)
    expect(retried.isError).toBeFalsy()
    const first = sendMessageMock.mock.calls[0]![0] as Record<string, unknown>
    const second = sendMessageMock.mock.calls[1]![0] as Record<string, unknown>
    expect(second['client_msg_id']).toBe(first['client_msg_id'])
  })

  it('keeps idempotency separate across recipients and reply anchors', () => {
    const base = sendMessage.turnClientMessageId('turn-key', '@bob', 'msg_1')
    expect(sendMessage.turnClientMessageId('turn-key', '@carol', 'msg_1')).not.toBe(base)
    expect(sendMessage.turnClientMessageId('turn-key', '@bob', 'msg_2')).not.toBe(base)
    expect(sendMessage.turnClientMessageId('other-turn', '@bob', 'msg_1')).not.toBe(base)
    expect(sendMessage.turnClientMessageId('turn-key', '@bob', 'msg_1', 1)).not.toBe(base)
  })
})

describe('agentchat_list_inbox', () => {
  it('calls listConversations and trims to limit', async () => {
    const conversations = Array.from({ length: 30 }, (_, i) => ({
      id: `conv_${i}`,
      type: 'direct' as const,
    }))
    const listMock = vi.fn().mockResolvedValue(conversations)
    const handler = listInbox.createHandler(
      makeCtx({ listConversations: listMock }),
    )
    const result = await handler({ limit: 25, offset: 0 })

    expect(listMock).toHaveBeenCalledWith({ limit: 26, offset: 0 })
    const payload = parseJsonContent(result) as {
      count: number
      has_more: boolean
      conversations: unknown[]
    }
    expect(payload.count).toBe(25)
    expect(payload.has_more).toBe(true)
    expect(payload.conversations).toHaveLength(25)
  })

  it('reports has_more=false when result fits within limit', async () => {
    const listMock = vi.fn().mockResolvedValue([{ id: 'conv_1' }, { id: 'conv_2' }])
    const handler = listInbox.createHandler(
      makeCtx({ listConversations: listMock }),
    )
    const result = await handler({ limit: 25, offset: 0 })
    const payload = parseJsonContent(result) as { has_more: boolean; count: number }
    expect(payload.has_more).toBe(false)
    expect(payload.count).toBe(2)
  })
})

describe('agentchat_get_conversation', () => {
  it('passes limit and beforeSeq through to getMessages', async () => {
    const getMessagesMock = vi.fn().mockResolvedValue([{ id: 'msg_1', seq: 50 }])
    const handler = getConversation.createHandler(
      makeCtx({ getMessages: getMessagesMock }),
    )
    await handler({ conversation_id: 'conv_x', limit: 50, before_seq: 100 })
    expect(getMessagesMock).toHaveBeenCalledWith('conv_x', {
      limit: 50,
      beforeSeq: 100,
    })
  })

  it('omits beforeSeq when not provided', async () => {
    const getMessagesMock = vi.fn().mockResolvedValue([])
    const handler = getConversation.createHandler(
      makeCtx({ getMessages: getMessagesMock }),
    )
    await handler({ conversation_id: 'conv_x', limit: 25 })
    expect(getMessagesMock).toHaveBeenCalledWith('conv_x', { limit: 25 })
  })

  it('anchors the window, orders it chronologically, and returns compact social context', async () => {
    const getMessagesMock = vi.fn().mockResolvedValue([
      {
        id: 'msg_2',
        conversation_id: 'grp_ops',
        // The server-authored context is the canonical identity source when
        // legacy/top-level sender data disagrees.
        sender: 'test',
        seq: 51,
        type: 'text',
        content: { text: 'new question' },
        metadata: { reply_to: 'msg_1' },
        status: 'delivered',
        created_at: '2026-07-29T01:00:00Z',
        context: {
          conversation: { type: 'group', group_name: 'Ops', member_count: 5 },
          sender: { handle: 'bob', display_name: 'Bob', kind: 'agent' },
          mentions: ['test'],
        },
      },
      {
        id: 'msg_1',
        conversation_id: 'grp_ops',
        sender: 'alice',
        seq: 50,
        type: 'text',
        content: { text: 'original context' },
        metadata: {},
        status: 'read',
        created_at: '2026-07-29T00:59:00Z',
        context: {
          conversation: { type: 'group', group_name: 'Ops', member_count: 5 },
          sender: { handle: 'alice', display_name: 'Alice', kind: 'agent' },
          mentions: [],
        },
      },
    ])
    const contextMock = vi.fn().mockResolvedValue({
      conversation_id: 'grp_ops',
      type: 'group',
      group: {
        name: 'Ops',
        description: 'Production operations',
        member_count: 5,
        your_role: 'member',
      },
      counterparty: null,
      relationship: null,
      unread: { count: 3, oldest_seq: 51, newest_seq: 53 },
    })
    const checkContactMock = vi.fn().mockResolvedValue({
      is_contact: true,
      added_at: '2026-07-01T00:00:00Z',
      notes: 'Owns deployment coordination',
    })
    const handler = getConversation.createHandler(
      makeCtx({
        getMessages: getMessagesMock,
        getConversationContext: contextMock,
        checkContact: checkContactMock,
      } as never),
    )
    const result = await handler({
      conversation_id: 'grp_ops',
      limit: 30,
      around_message_id: 'msg_2',
    })
    const value = parseJsonContent(result) as {
      conversation: {
        group: { description: string }
      }
      focus: {
        sender_relationship: { note: string }
      }
      unread: { count: number }
      messages: Array<{
        message_id: string
        sender: { handle: string }
        mentioned_you: boolean
        delivery: { scope: string }
        reply_to?: { parent: { content: { text: string } } }
      }>
    }
    expect(getMessagesMock).toHaveBeenCalledWith('grp_ops', {
      limit: 30,
      aroundMessageId: 'msg_2',
    })
    expect(value.messages.map((message) => message.message_id)).toEqual([
      'msg_1',
      'msg_2',
    ])
    expect(value.messages[1]?.sender.handle).toBe('@bob')
    expect(value.messages[1]?.delivery.scope).toBe('your_receipt')
    expect(value.messages[1]?.mentioned_you).toBe(true)
    expect(value.messages[1]?.reply_to?.parent.content.text).toBe(
      'original context',
    )
    expect(value.conversation.group.description).toBe('Production operations')
    expect(value.focus.sender_relationship.note).toBe(
      'Owns deployment coordination',
    )
    expect(value.unread.count).toBe(3)
  })

  it('degrades to an inferred room when the context endpoint is unavailable', async () => {
    const getMessagesMock = vi.fn().mockResolvedValue([{ id: 'msg_1', seq: 1 }])
    const handler = getConversation.createHandler(
      makeCtx({ getMessages: getMessagesMock }),
    )
    const result = await handler({ conversation_id: 'conv_x', limit: 50 })
    expect(
      (
        parseJsonContent(result) as {
          conversation: { type: string; conversation_id: string }
        }
    ).conversation,
    ).toMatchObject({ conversation_id: 'conv_x', type: 'direct' })
  })

  it('returns explicit attention pointers without refetching messages already in the primary window', async () => {
    const getMessagesMock = vi.fn().mockResolvedValue([
      {
        id: 'msg_latest',
        conversation_id: 'grp_ops',
        sender: 'bob',
        seq: 11,
        content: { text: 'latest' },
        context: { mentions: [] },
      },
      {
        id: 'msg_mention',
        conversation_id: 'grp_ops',
        sender: 'alice',
        seq: 10,
        content: { text: '@test please look' },
        context: { mentions: ['test'] },
      },
    ])
    const handler = getConversation.createHandler(
      makeCtx({ getMessages: getMessagesMock }),
    )

    const result = await handler({
      conversation_id: 'grp_ops',
      limit: 30,
      around_message_id: 'msg_latest',
      attention_message_ids: ['msg_mention'],
    })
    const value = parseJsonContent(result) as {
      attention: {
        message_ids: string[]
        messages: Array<{
          message_id: string
          mentioned_you: boolean
          in_primary_window: boolean
          primary_window_index: number
        }>
      }
    }
    expect(getMessagesMock).toHaveBeenCalledTimes(1)
    expect(value.attention.message_ids).toEqual(['msg_mention'])
    expect(value.attention.messages).toMatchObject([
      {
        message_id: 'msg_mention',
        mentioned_you: true,
        in_primary_window: true,
        primary_window_index: 0,
      },
    ])
  })

  it('hydrates an exact attention message that falls outside the primary window', async () => {
    const getMessagesMock = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'msg_latest',
          conversation_id: 'grp_ops',
          sender: 'bob',
          seq: 100,
          content: { text: 'latest update' },
          context: { mentions: [] },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'msg_old_mention',
          conversation_id: 'grp_ops',
          sender: 'alice',
          seq: 12,
          content: { text: '@test old but explicit request' },
          context: { mentions: ['test'] },
        },
      ])
    const handler = getConversation.createHandler(
      makeCtx({ getMessages: getMessagesMock }),
    )

    const result = await handler({
      conversation_id: 'grp_ops',
      limit: 30,
      around_message_id: 'msg_latest',
      attention_message_ids: ['msg_old_mention'],
    })
    const value = parseJsonContent(result) as {
      messages: Array<{ message_id: string }>
      attention: {
        messages: Array<{
          message_id: string
          content: { text: string }
          in_primary_window: boolean
        }>
      }
    }
    expect(getMessagesMock).toHaveBeenNthCalledWith(1, 'grp_ops', {
      limit: 30,
      aroundMessageId: 'msg_latest',
    })
    expect(getMessagesMock).toHaveBeenNthCalledWith(2, 'grp_ops', {
      limit: 1,
      aroundMessageId: 'msg_old_mention',
    })
    expect(value.messages.map((message) => message.message_id)).toEqual([
      'msg_latest',
    ])
    expect(value.attention.messages).toMatchObject([
      {
        message_id: 'msg_old_mention',
        content: { text: '@test old but explicit request' },
        in_primary_window: false,
      },
    ])
  })

  it('fails closed when a requested anchor is absent from the returned window', async () => {
    const getMessagesMock = vi.fn().mockResolvedValue([
      { id: 'msg_newer', seq: 99 },
    ])
    const handler = getConversation.createHandler(
      makeCtx({ getMessages: getMessagesMock }),
    )

    const result = await handler({
      conversation_id: 'conv_x',
      limit: 30,
      around_message_id: 'msg_focus',
    })

    expect(result.isError).toBe(true)
    expect(
      (result.content[0] as { type: 'text'; text: string }).text,
    ).toContain('anchored history support is required')
  })

})

describe('agentchat_mark_read', () => {
  it('calls markAsRead with the message_id', async () => {
    const markMock = vi.fn().mockResolvedValue(undefined)
    const handler = markRead.createHandler(makeCtx({ markAsRead: markMock }))
    const result = await handler({ message_id: 'msg_42' })
    expect(markMock).toHaveBeenCalledWith('msg_42')
    expect(parseJsonContent(result)).toEqual({ ok: true, message_id: 'msg_42' })
  })
})

describe('agentchat_get_my_status', () => {
  it('returns the getMe response payload as JSON', async () => {
    const me = {
      handle: '@alice',
      status: 'active',
      paused_by_owner: 'none',
      settings: { inbox_mode: 'open' },
    }
    const getMeMock = vi.fn().mockResolvedValue(me)
    const handler = getMyStatus.createHandler(makeCtx({ getMe: getMeMock }))
    const result = await handler({})
    expect(getMeMock).toHaveBeenCalled()
    expect(parseJsonContent(result)).toEqual(me)
  })
})

describe('agentchat_list_contacts', () => {
  it('passes limit + offset to listContacts and unwraps the result', async () => {
    const listMock = vi.fn().mockResolvedValue({
      contacts: [{ handle: '@bob' }, { handle: '@carol' }],
      total: 42,
      limit: 50,
      offset: 0,
    })
    const handler = listContacts.createHandler(
      makeCtx({ listContacts: listMock }),
    )
    const result = await handler({ limit: 50, offset: 0 })
    expect(listMock).toHaveBeenCalledWith({ limit: 50, offset: 0 })
    const payload = parseJsonContent(result) as {
      count: number
      total: number
      contacts: unknown[]
    }
    expect(payload.count).toBe(2)
    expect(payload.total).toBe(42)
  })
})

describe('agentchat_add_contact', () => {
  it('calls addContact with the handle', async () => {
    const addMock = vi.fn().mockResolvedValue(undefined)
    const handler = addContact.createHandler(makeCtx({ addContact: addMock }))
    const result = await handler({ handle: '@bob' })
    expect(addMock).toHaveBeenCalledWith('@bob')
    expect(parseJsonContent(result)).toEqual({ ok: true, handle: '@bob', note_saved: false })
  })
})

describe('agentchat_remove_contact', () => {
  it('calls removeContact with the handle', async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined)
    const handler = removeContact.createHandler(
      makeCtx({ removeContact: removeMock }),
    )
    const result = await handler({ handle: '@bob' })
    expect(removeMock).toHaveBeenCalledWith('@bob')
    expect(parseJsonContent(result)).toEqual({ ok: true, handle: '@bob' })
  })
})

describe('agentchat_get_agent_profile', () => {
  it('calls getAgent with the handle and returns the profile', async () => {
    const profile = { handle: '@bob', display_name: 'Bob', status: 'active' }
    const getAgentMock = vi.fn().mockResolvedValue(profile)
    const handler = getAgentProfile.createHandler(
      makeCtx({ getAgent: getAgentMock }),
    )
    const result = await handler({ handle: '@bob' })
    expect(getAgentMock).toHaveBeenCalledWith('@bob')
    expect(parseJsonContent(result)).toEqual(profile)
  })
})

describe('agentchat_block_agent', () => {
  it('calls blockAgent with the handle', async () => {
    const blockMock = vi.fn().mockResolvedValue(undefined)
    const handler = blockAgent.createHandler(makeCtx({ blockAgent: blockMock }))
    const result = await handler({ handle: '@bob' })
    expect(blockMock).toHaveBeenCalledWith('@bob')
    expect(parseJsonContent(result)).toEqual({
      ok: true,
      handle: '@bob',
      blocked: true,
    })
  })
})

describe('agentchat_report_agent', () => {
  it('calls reportAgent with handle + reason', async () => {
    const reportMock = vi.fn().mockResolvedValue(undefined)
    const handler = reportAgent.createHandler(
      makeCtx({ reportAgent: reportMock }),
    )
    const result = await handler({ handle: '@bob', reason: 'sending phishing links' })
    expect(reportMock).toHaveBeenCalledWith('@bob', 'sending phishing links')
    expect(parseJsonContent(result)).toEqual({
      ok: true,
      handle: '@bob',
      reported: true,
      blocked: true,
    })
  })

  it('passes undefined reason when not provided', async () => {
    const reportMock = vi.fn().mockResolvedValue(undefined)
    const handler = reportAgent.createHandler(
      makeCtx({ reportAgent: reportMock }),
    )
    await handler({ handle: '@bob' })
    expect(reportMock).toHaveBeenCalledWith('@bob', undefined)
  })
})
