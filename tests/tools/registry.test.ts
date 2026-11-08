import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import {
  registerAllTools,
  RETIRED_TOOL_NAMES,
  SIGNUP_TOOL_NAMES,
  TOOL_COUNT,
  TOOL_NAMES,
  visibleToolNames,
  WEBHOOK_TOOL_NAMES,
} from '../../src/tools/index.js'
import type { AgentChatClient } from 'agentchatme'

// Stub client — no methods called by registration alone, but the
// registry function expects a typed value. registerAllTools doesn't touch
// the client; only handler invocation does.
const stubClient = {} as unknown as AgentChatClient

function ctx() {
  return {
    client: stubClient,
    logger: pino({ level: 'silent' }),
    selfHandle: '@test',
    semaphore: new Semaphore(10),
    inflight: new Set<Promise<unknown>>(),
    rest: {
      apiBase: 'https://api.agentchat.me',
      apiKey: null,
      fetchImpl: globalThis.fetch,
    },
    turnKey: () => undefined,
  }
}

/** The full surface after Phase 4, in tools/list order. */
const EXPECTED_TOOL_NAMES = [
  'agentchat_send_message',
  'agentchat_list_conversations',
  'agentchat_get_conversation',
  'agentchat_mark_read',
  'agentchat_get_my_status',
  'agentchat_list_contacts',
  'agentchat_add_contact',
  'agentchat_remove_contact',
  'agentchat_get_agent_profile',
  'agentchat_block_agent',
  'agentchat_unblock_agent',
  'agentchat_report_agent',
  'agentchat_create_group',
  'agentchat_get_group',
  'agentchat_list_group_invites',
  'agentchat_respond_to_invite',
  'agentchat_leave_group',
  'agentchat_register',
  'agentchat_verify_otp',
  'agentchat_set_webhook',
  'agentchat_clear_webhook',
  'agentchat_wait',
  'agentchat_test_webhook',
  'agentchat_decide',
  'agentchat_inbox',
  'agentchat_mute',
  'agentchat_update_group',
  'agentchat_manage_members',
  'agentchat_delete_group',
  'agentchat_search_agents',
  'agentchat_delete_message',
  'agentchat_update_profile',
  'agentchat_send_file',
]

describe('registerAllTools', () => {
  it('registers exactly TOOL_COUNT tools, by the settled names, in a stable order', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    const registered = registerAllTools(server, ctx())
    // 18 pre-hosted-core tools − 2 (accept + reject merged into respond_to_invite)
    // + register/verify_otp/set_webhook/clear_webhook + wait/test_webhook
    // + decide + inbox + the 8 Phase 4 tools.
    expect(TOOL_COUNT).toBe(33)
    expect(TOOL_NAMES).toEqual(EXPECTED_TOOL_NAMES)
    expect(registered).toEqual(EXPECTED_TOOL_NAMES)
  })

  it('the renamed and merged tools are out of the listed surface; their old names are the retired aliases', () => {
    expect(RETIRED_TOOL_NAMES).toEqual([
      'agentchat_list_inbox',
      'agentchat_accept_group_invite',
      'agentchat_reject_group_invite',
    ])
    for (const old of RETIRED_TOOL_NAMES) {
      expect(TOOL_NAMES).not.toContain(old)
      expect(visibleToolNames()).not.toContain(old)
      expect(visibleToolNames({ registered: true, webhookTools: true })).not.toContain(old)
    }
    // Aliases are registered (callable) but never counted as listed tools.
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    expect(registerAllTools(server, ctx())).toHaveLength(33)
  })

  it('every registration has a unique tool name', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerAllTools(server, ctx())
    // Second registration on the same server must throw because every
    // tool name is duplicated. If this passes silently, we've drifted
    // and risk shipping duplicate tool names.
    expect(() => registerAllTools(server, ctx())).toThrow()
  })

  describe('visibility', () => {
    it('absent: everything, as before (the stdio binary and older embedders)', () => {
      expect(visibleToolNames()).toEqual(EXPECTED_TOOL_NAMES)
      expect(visibleToolNames(undefined)).toHaveLength(33)
    })

    it('unregistered: only the sign-up pair and get_my_status, whatever webhookTools says', () => {
      const expected = ['agentchat_get_my_status', 'agentchat_register', 'agentchat_verify_otp']
      expect(visibleToolNames({ registered: false, webhookTools: false })).toEqual(expected)
      expect(visibleToolNames({ registered: false, webhookTools: true })).toEqual(expected)
      const server = new McpServer({ name: 'test', version: '0.0.0' })
      expect(registerAllTools(server, ctx(), { registered: false, webhookTools: true })).toEqual(expected)
    })

    it('registered without webhook tools: no sign-up pair, no webhook tools — 28 tools', () => {
      const names = visibleToolNames({ registered: true, webhookTools: false })
      expect(names).toHaveLength(28)
      for (const hidden of [...SIGNUP_TOOL_NAMES, ...WEBHOOK_TOOL_NAMES]) {
        expect(names).not.toContain(hidden)
      }
      expect(names).toContain('agentchat_get_my_status')
      expect(names).toContain('agentchat_inbox')
      expect(names).toContain('agentchat_send_file')
      // Order is the registry's: a filtered view, never a reshuffle.
      expect(names).toEqual(EXPECTED_TOOL_NAMES.filter((n) => names.includes(n)))
    })

    it('registered with webhook tools: adds exactly set/test/clear_webhook — 31 tools', () => {
      const names = visibleToolNames({ registered: true, webhookTools: true })
      expect(names).toHaveLength(31)
      expect(WEBHOOK_TOOL_NAMES).toEqual([
        'agentchat_set_webhook',
        'agentchat_clear_webhook',
        'agentchat_test_webhook',
      ])
      for (const shown of WEBHOOK_TOOL_NAMES) expect(names).toContain(shown)
      for (const hidden of SIGNUP_TOOL_NAMES) expect(names).not.toContain(hidden)
      expect(SIGNUP_TOOL_NAMES).toEqual(['agentchat_register', 'agentchat_verify_otp'])
    })
  })
})
