import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildMcpServer } from '../../src/lib.js'
import { DESTRUCTIVE, openWorld, READ, WRITE, WRITE_IDEMPOTENT } from '../../src/tools/_annotations.js'
import { TOOL_NAMES } from '../../src/tools/index.js'

// ─── MCP safety hints on every tool (rule 6) ───────────────────────────────
//
// Every tool carries all four ToolAnnotations hints explicitly, as a host
// receives them from tools/list, and no tool is both read-only and
// destructive. The read-only, destructive and open-world sets are pinned by
// name so a new tool must declare itself here as well as in its file.

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

type Listed = { name: string; annotations?: Record<string, unknown> }

async function listTools(): Promise<Listed[]> {
  const server = buildMcpServer({ apiBase: 'https://annotations.invalid', apiKey: null })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'annotations', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const { tools } = await client.listTools()
    return tools.map((tool) => ({ name: tool.name, annotations: tool.annotations as Record<string, unknown> }))
  } finally {
    await client.close()
    await server.close()
  }
}

const READ_ONLY = [
  'agentchat_inbox',
  'agentchat_list_conversations',
  'agentchat_get_conversation',
  'agentchat_get_my_status',
  'agentchat_list_contacts',
  'agentchat_get_agent_profile',
  'agentchat_get_group',
  'agentchat_list_group_invites',
  'agentchat_search_agents',
]

const DESTRUCTIVE_TOOLS = [
  'agentchat_delete_group',
  'agentchat_delete_message',
  'agentchat_leave_group',
  'agentchat_remove_contact',
  'agentchat_block_agent',
  'agentchat_report_agent',
  'agentchat_manage_members',
]

const OPEN_WORLD = [
  'agentchat_send_message',
  'agentchat_send_file',
  'agentchat_test_webhook',
  'agentchat_register',
]

const IDEMPOTENT_WRITES = [
  'agentchat_mute',
  'agentchat_decide',
  'agentchat_mark_read',
  'agentchat_add_contact',
  'agentchat_unblock_agent',
  'agentchat_set_webhook',
  'agentchat_clear_webhook',
  'agentchat_update_group',
  'agentchat_update_profile',
  'agentchat_respond_to_invite',
]

describe('tool annotations', () => {
  it('every tool carries all four hints as booleans, exactly as a host receives them', async () => {
    const tools = await listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined()
      for (const hint of HINTS) {
        expect(typeof tool.annotations![hint], `${tool.name}.${hint}`).toBe('boolean')
      }
    }
  })

  it('no tool is both read-only and destructive (rule 6: never mixed in one tool)', async () => {
    for (const tool of await listTools()) {
      const a = tool.annotations!
      expect(a['readOnlyHint'] && a['destructiveHint'], tool.name).toBeFalsy()
      // A read-only tool is by definition idempotent.
      if (a['readOnlyHint']) expect(a['idempotentHint'], `${tool.name} read-only but not idempotent`).toBe(true)
    }
  })

  it('the read-only set is exactly the reads; agentchat_wait acks delivery, so it is not one', async () => {
    const tools = await listTools()
    const readOnly = tools.filter((t) => t.annotations!['readOnlyHint'] === true).map((t) => t.name)
    expect(readOnly.sort()).toEqual([...READ_ONLY].sort())
    expect(readOnly).not.toContain('agentchat_wait')
  })

  it('the destructive set is exactly the removals: delete group/message, leave, remove contact, block, report, manage members', async () => {
    const tools = await listTools()
    const destructive = tools.filter((t) => t.annotations!['destructiveHint'] === true).map((t) => t.name)
    expect(destructive.sort()).toEqual([...DESTRUCTIVE_TOOLS].sort())
  })

  it('mute, decide and mark_read (and the other converging writes) are idempotent; sends and the test wake are not', async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations!]))
    for (const name of IDEMPOTENT_WRITES) {
      expect(byName.get(name)!['idempotentHint'], name).toBe(true)
      expect(byName.get(name)!['readOnlyHint'], name).toBe(false)
      expect(byName.get(name)!['destructiveHint'], name).toBe(false)
    }
    for (const name of [
      'agentchat_send_message',
      'agentchat_send_file',
      'agentchat_create_group',
      'agentchat_register',
      'agentchat_verify_otp',
      'agentchat_test_webhook',
      'agentchat_wait',
      'agentchat_manage_members',
    ]) {
      expect(byName.get(name)!['idempotentHint'], name).toBe(false)
    }
  })

  it('open world is exactly what leaves the platform: a message or file to a peer, a test wake, a sign-up email', async () => {
    const tools = await listTools()
    const open = tools.filter((t) => t.annotations!['openWorldHint'] === true).map((t) => t.name)
    expect(open.sort()).toEqual([...OPEN_WORLD].sort())
  })

  it('the presets are the only shapes in use', () => {
    expect(READ).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(WRITE_IDEMPOTENT).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(WRITE).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false })
    expect(DESTRUCTIVE).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false })
    expect(openWorld(WRITE)).toEqual({ ...WRITE, openWorldHint: true })
    expect(Object.isFrozen(READ)).toBe(true)
  })
})
