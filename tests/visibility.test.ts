import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildMcpServer, type ToolVisibility } from '../src/lib.js'
import { TOOL_NAMES } from '../src/tools/index.js'

// ─── Tools by situation (Phase 4 visibility) ───────────────────────────────
//
// Through the public library entry and a real MCP transport: what tools/list
// shows, and what the server instructions say, for each situation a hosted
// gateway can be in. The default (no option) is the full surface, so the
// stdio binary and older embedders keep working unchanged.

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

async function list(visibility?: ToolVisibility, apiKey: string | null = KEY) {
  const server = buildMcpServer({
    apiBase: 'https://visibility.invalid',
    apiKey,
    ...(apiKey ? { selfHandle: 'me' } : {}),
    ...(visibility ? { visibility } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'visibility', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const { tools } = await client.listTools()
    return { names: tools.map((t) => t.name), instructions: client.getInstructions() ?? '' }
  } finally {
    await client.close()
    await server.close()
  }
}

/** Every `agentchat_…` tool name a text mentions. */
function mentioned(text: string): Set<string> {
  return new Set(text.match(/agentchat_[a-z_]+/g) ?? [])
}

const SIGNUP = ['agentchat_register', 'agentchat_verify_otp']
const WEBHOOK = ['agentchat_set_webhook', 'agentchat_clear_webhook', 'agentchat_test_webhook']

describe('buildMcpServer visibility', () => {
  it('no option: the full surface, for a keyed and for a key-less session alike', async () => {
    const keyed = await list(undefined, KEY)
    const keyless = await list(undefined, null)
    expect(keyed.names).toEqual([...TOOL_NAMES])
    expect(keyless.names).toEqual([...TOOL_NAMES])
    expect(keyed.names).toHaveLength(33)
    expect(keyed.instructions).toContain('exposes 33 tools')
    expect(keyless.instructions).toContain('exposes 33 tools')
  })

  it('registered: false — only register, verify_otp and get_my_status; the instructions say sign up', async () => {
    const { names, instructions } = await list({ registered: false, webhookTools: false }, null)
    expect(names).toEqual(['agentchat_get_my_status', 'agentchat_register', 'agentchat_verify_otp'])
    expect(instructions).toContain('lists 3 tools')
    expect(instructions).toContain('Authorization: Bearer')
    // The instructions name only listed tools.
    for (const name of mentioned(instructions)) expect(names, name).toContain(name)
  })

  it('registered: false ignores webhookTools (the doorbell needs an identity)', async () => {
    const { names } = await list({ registered: false, webhookTools: true }, null)
    expect(names).toHaveLength(3)
    for (const name of WEBHOOK) expect(names).not.toContain(name)
  })

  it('registered: true, webhookTools: false — no sign-up pair, no doorbell, 28 tools, no doorbell paragraph', async () => {
    const { names, instructions } = await list({ registered: true, webhookTools: false })
    expect(names).toHaveLength(28)
    for (const name of [...SIGNUP, ...WEBHOOK]) expect(names).not.toContain(name)
    expect(names).toContain('agentchat_get_my_status')
    expect(instructions).toContain('exposes 28 tools')
    expect(instructions).not.toContain('Being woken')
    for (const name of mentioned(instructions)) expect(names, name).toContain(name)
  })

  it('registered: true, webhookTools: true — the doorbell is back, 31 tools, and the instructions explain it', async () => {
    const { names, instructions } = await list({ registered: true, webhookTools: true })
    expect(names).toHaveLength(31)
    for (const name of WEBHOOK) expect(names).toContain(name)
    for (const name of SIGNUP) expect(names).not.toContain(name)
    expect(instructions).toContain('exposes 31 tools')
    expect(instructions).toContain('Being woken')
    for (const name of mentioned(instructions)) expect(names, name).toContain(name)
  })

  it('a filtered list keeps the registry order', async () => {
    const { names } = await list({ registered: true, webhookTools: true })
    expect(names).toEqual(TOOL_NAMES.filter((n) => names.includes(n)))
  })

  it('a hidden tool is not callable: the server answers with a tool-not-found error', async () => {
    const server = buildMcpServer({
      apiBase: 'https://visibility.invalid',
      apiKey: KEY,
      selfHandle: 'me',
      visibility: { registered: true, webhookTools: false },
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'visibility', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      // The SDK answers an unknown tool with an error result, not a crash.
      const result = await client.callTool({
        name: 'agentchat_register',
        arguments: { email: 'a@b.example', handle: 'new-bot' },
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0]!.text
      expect(text).toMatch(/not found/i)
      expect(text).toContain('agentchat_register')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
