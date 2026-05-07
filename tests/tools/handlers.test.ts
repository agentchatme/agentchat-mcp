import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
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
    const result = await handler({ limit: 25 })

    expect(listMock).toHaveBeenCalled()
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
    const result = await handler({ limit: 25 })
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
    expect(parseJsonContent(result)).toEqual({ ok: true, handle: '@bob' })
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
