import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildInstructions } from '../../src/instructions.js'
import { buildMcpServer } from '../../src/lib.js'
import { TOOL_COUNT } from '../../src/tools/index.js'

// ─── One receive sequence, no contradictions ───────────────────────────────
//
// Every text the model reads — the server instructions and each tool's
// description — must tell the same story:
//
//   woken → agentchat_inbox → per card: agentchat_decide (dismiss / defer,
//   or reply) → for reply: agentchat_get_conversation → agentchat_send_message
//
// with agentchat_wait as the live-conversation body puller, and two read
// states: delivered (the machine received it) and read (a verdict or an
// explicit mark-read). The texts drifted once (the instructions said inbox
// first, the webhook tools said wait first, the README said both); this
// suite is the guard.

async function listDescriptions(): Promise<Map<string, string>> {
  const server = buildMcpServer({ apiBase: 'https://sequence.invalid', apiKey: null })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'receive-sequence', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const { tools } = await client.listTools()
    return new Map(tools.map((tool) => [tool.name, tool.description ?? '']))
  } finally {
    await client.close()
    await server.close()
  }
}

/** Positions of the names in `text`, in the order given; -1 when absent. */
function order(text: string, names: string[]): number[] {
  return names.map((name) => text.indexOf(name))
}

const SEQUENCE = [
  'agentchat_inbox',
  'agentchat_decide',
  'agentchat_get_conversation',
  'agentchat_send_message',
]

describe('one receive sequence across every text', () => {
  it('nothing tells the model to call agentchat_wait first, or to read with it on a wake', async () => {
    const descriptions = await listDescriptions()
    const texts = [
      ...descriptions.values(),
      buildInstructions('stdio', TOOL_COUNT),
      buildInstructions('hosted', TOOL_COUNT),
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/agentchat_wait first/i)
      expect(text).not.toMatch(/read with agentchat_wait/i)
      expect(text).not.toMatch(/call agentchat_list_inbox (first|at the start)/i)
    }
  })

  it('the instructions name the sequence in order, for both compositions', () => {
    for (const mode of ['stdio', 'hosted'] as const) {
      const text = buildInstructions(mode, TOOL_COUNT)
      const positions = order(text, SEQUENCE)
      expect(positions.every((p) => p >= 0), text).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      expect(text).toContain('call agentchat_inbox first')
      expect(text).toContain('record the verdict first')
      expect(text).toContain('looking marks nothing delivered or read')
      expect(text).toContain('reply and dismiss mark the conversation read through that message; defer leaves it unread')
      expect(text).toContain('delivered means your machine received a message; read means you looked')
      expect(text).toContain('marks them delivered — never read')
    }
  })

  it('the tools that start a wake point at the tray', async () => {
    const descriptions = await listDescriptions()
    expect(descriptions.get('agentchat_inbox')!.startsWith('Call this FIRST when woken')).toBe(true)
    expect(descriptions.get('agentchat_set_webhook')).toContain('call agentchat_inbox first')
    expect(descriptions.get('agentchat_wait')).toContain('look at the tray with agentchat_inbox FIRST')
    expect(descriptions.get('agentchat_list_inbox')).toContain('call agentchat_inbox instead')
  })

  it('every reading tool says what it does to read state, consistently', async () => {
    const descriptions = await listDescriptions()
    // The tray: a preview, marks nothing.
    expect(descriptions.get('agentchat_inbox')).toContain('A card is a preview, like a phone banner')
    expect(descriptions.get('agentchat_inbox')).toContain('marks NOTHING delivered or read')
    // The puller: delivered, never read.
    expect(descriptions.get('agentchat_wait')).toContain('marked delivered to their senders')
    expect(descriptions.get('agentchat_wait')).toContain('never read')
    // History: nothing.
    expect(descriptions.get('agentchat_get_conversation')).toContain('Reading never marks anything read')
    // The verdict: read through the anchor; defer nothing.
    expect(descriptions.get('agentchat_decide')).toContain(
      '`reply` and `dismiss` mark the conversation read through through_message_id',
    )
    expect(descriptions.get('agentchat_decide')).toContain('`defer` leaves everything unread')
    // The explicit marker: two forms, and the same "looking never marks" rule.
    expect(descriptions.get('agentchat_mark_read')).toContain('conversation_id + through_message_id')
    expect(descriptions.get('agentchat_mark_read')).toContain('Looking never marks read')
  })

  it('the per-card sequence reads in order wherever it is spelled out', async () => {
    const descriptions = await listDescriptions()
    const spelledOut: Record<string, string[]> = {
      agentchat_inbox: ['agentchat_decide', 'agentchat_get_conversation', 'agentchat_send_message'],
      // The verdict tool speaks of the steps after itself.
      agentchat_decide: ['agentchat_get_conversation', 'agentchat_send_message'],
    }
    for (const [name, names] of Object.entries(spelledOut)) {
      const positions = order(descriptions.get(name)!, names)
      expect(positions.every((p) => p >= 0), name).toBe(true)
      expect([...positions].sort((a, b) => a - b), name).toEqual(positions)
    }
  })
})
