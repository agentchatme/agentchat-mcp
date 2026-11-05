import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildMcpServer } from '../../src/lib.js'
import { RETIRED_TOOL_NAMES as REGISTRY_RETIRED } from '../../src/tools/index.js'

// ─── Publish-blocking tool-contract snapshot ───────────────────────────────
//
// Pins the WIRE surface (tool name + JSON-Schema inputSchema, exactly as an
// MCP host receives it from tools/list) of every tool that existed before
// the hosted-core split, under the names settled in Phase 4 (2026-11):
// `agentchat_list_inbox` → `agentchat_list_conversations`, and
// `agentchat_accept_group_invite` + `agentchat_reject_group_invite` →
// `agentchat_respond_to_invite`. Any change to a frozen name or input schema
// fails this suite and must block publish: MCP hosts, and the hosted
// endpoint, both depend on this surface verbatim.
//
// ADDITIONS ARE ALLOWED: new tools don't touch the fixture. When a new tool
// ships and should itself become frozen, add its name to LEGACY_TOOL_NAMES
// and regenerate.
//
// Descriptions are deliberately NOT pinned — they are prompt guidance and
// may improve between releases without breaking any caller. (Parameter
// descriptions ARE part of the JSON Schema, so they are pinned.)
//
// To regenerate after an INTENTIONAL contract change (rare — this is a
// compatibility promise, not a convenience):
//   CONTRACT_FIXTURE_WRITE=1 pnpm vitest run tests/tools/contract-snapshot.test.ts
// The run rewrites the fixture and then fails on purpose; review the diff,
// then re-run the suite normally.

const LEGACY_TOOL_NAMES = [
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
] as const

/**
 * Names retired in Phase 4. For one release they stay callable as hidden
 * aliases (src/tools/_retired.ts) but they must never be LISTED again, and
 * they never enter the frozen set under the old spelling.
 */
const RETIRED_TOOL_NAMES = [
  'agentchat_list_inbox',
  'agentchat_accept_group_invite',
  'agentchat_reject_group_invite',
] as const

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/tool-contract.v1.json', import.meta.url),
)

interface ListedTool {
  name: string
  inputSchema: unknown
}

async function listCurrentTools(): Promise<ListedTool[]> {
  const server = buildMcpServer({
    apiBase: 'https://contract.invalid',
    apiKey: null,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'contract-snapshot', version: '0.0.0' })
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])
  try {
    const { tools } = await client.listTools()
    // Round-trip through JSON so the comparison sees exactly what a host
    // sees on the wire — no class instances, no undefined-holding fields.
    return JSON.parse(
      JSON.stringify(
        tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
      ),
    ) as ListedTool[]
  } finally {
    await client.close()
    await server.close()
  }
}

function fixtureFromTools(tools: ListedTool[]): Record<string, unknown> {
  const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]))
  const fixture: Record<string, unknown> = {}
  for (const name of [...LEGACY_TOOL_NAMES].sort()) {
    fixture[name] = byName.get(name)
  }
  return fixture
}

describe('tool contract snapshot (publish-blocking)', () => {
  it('every pre-existing tool keeps its exact name and input schema', async () => {
    const tools = await listCurrentTools()

    if (process.env['CONTRACT_FIXTURE_WRITE'] === '1') {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true })
      fs.writeFileSync(
        FIXTURE_PATH,
        `${JSON.stringify(fixtureFromTools(tools), null, 2)}\n`,
      )
      throw new Error(
        `Contract fixture rewritten at ${FIXTURE_PATH}. Review the diff — every changed entry is a breaking change for MCP hosts — then re-run WITHOUT CONTRACT_FIXTURE_WRITE.`,
      )
    }

    expect(
      fs.existsSync(FIXTURE_PATH),
      `missing contract fixture ${FIXTURE_PATH} — run with CONTRACT_FIXTURE_WRITE=1 once to create it`,
    ).toBe(true)
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as Record<
      string,
      unknown
    >

    // The fixture itself must cover exactly the frozen set — catches a
    // hand-edited fixture drifting away from LEGACY_TOOL_NAMES.
    expect(Object.keys(fixture).sort()).toEqual([...LEGACY_TOOL_NAMES].sort())

    const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]))
    for (const name of LEGACY_TOOL_NAMES) {
      expect(byName.has(name), `pre-existing tool ${name} disappeared from tools/list`).toBe(true)
      expect(byName.get(name), `input schema changed for pre-existing tool ${name}`).toEqual(
        fixture[name],
      )
    }
  })

  it('tool names are unique across the whole surface', async () => {
    const tools = await listCurrentTools()
    const names = tools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('additions are visible without touching the frozen set', async () => {
    const tools = await listCurrentTools()
    const names = new Set(tools.map((tool) => tool.name))
    const added = [
      'agentchat_register',
      'agentchat_verify_otp',
      'agentchat_set_webhook',
      'agentchat_clear_webhook',
      'agentchat_wait',
      'agentchat_test_webhook',
      'agentchat_decide',
      'agentchat_inbox',
      // Phase 4
      'agentchat_mute',
      'agentchat_update_group',
      'agentchat_manage_members',
      'agentchat_delete_group',
      'agentchat_search_agents',
      'agentchat_delete_message',
      'agentchat_update_profile',
      'agentchat_send_file',
    ]
    for (const name of added) {
      expect(names.has(name), `expected added tool ${name} in tools/list`).toBe(true)
    }
    expect(tools.length).toBe(LEGACY_TOOL_NAMES.length + added.length)
  })

  it('the retired names are not listed (aliases are allowed in the registry, forbidden in the listing)', async () => {
    expect([...REGISTRY_RETIRED]).toEqual([...RETIRED_TOOL_NAMES])
    const tools = await listCurrentTools()
    const names = new Set(tools.map((tool) => tool.name))
    for (const retired of RETIRED_TOOL_NAMES) {
      expect(names.has(retired), `retired tool ${retired} is listed`).toBe(false)
      expect(LEGACY_TOOL_NAMES as readonly string[]).not.toContain(retired)
    }
  })
})
