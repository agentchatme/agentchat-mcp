import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildInstructions, HOST_INSTRUCTIONS_WINDOW } from '../../src/instructions.js'
import * as setWebhook from '../../src/tools/set-webhook.js'
import * as testWebhook from '../../src/tools/test-webhook.js'
import { buildMcpServer } from '../../src/lib.js'
import { TOOL_COUNT } from '../../src/tools/index.js'

// ─── One receive sequence, no contradictions ───────────────────────────────
//
// Every text the model reads — the server instructions and each tool's
// description — must tell the same story:
//
//   woken → agentchat_inbox → per card: agentchat_decide dismiss / defer at
//   once, or agentchat_get_conversation → agentchat_send_message → then
//   agentchat_decide reply (never before the send: a send marks nothing read,
//   so a reply recorded first and a run that stops in between leaves the peer
//   read and unanswered)
//
// with agentchat_wait as the live-conversation body puller, and two read
// states: delivered (the machine received it) and read (a verdict or an
// explicit mark-read). The texts drifted once (the instructions said inbox
// first, the webhook tools said wait first, the README said both); this
// suite is the guard.

async function listTools() {
  const server = buildMcpServer({ apiBase: 'https://sequence.invalid', apiKey: null })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'receive-sequence', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
    await server.close()
  }
}

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
      expect(text).not.toMatch(/call agentchat_list_conversations (first|at the start)/i)
      // The retired names never appear in any text the model reads.
      expect(text).not.toContain('agentchat_list_inbox')
      expect(text).not.toContain('agentchat_accept_group_invite')
      expect(text).not.toContain('agentchat_reject_group_invite')
      expect(text).not.toContain('defer_seconds')
      // The reply verdict is never told to come before the send.
      expect(text).not.toMatch(/record the verdict first|before you act on it|before you open|recorded before you|the send is (your |the )?verdict/i)
    }
  })

  it('the instructions name the sequence in order, for both compositions', () => {
    for (const mode of ['stdio', 'hosted'] as const) {
      const text = buildInstructions(mode, TOOL_COUNT)
      const positions = order(text, SEQUENCE)
      expect(positions.every((p) => p >= 0), text).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      expect(text).toContain('call agentchat_inbox first')
      expect(text).toContain('record dismiss (or defer) right away')
      // reply comes last: after the send, through the newest message read.
      const send = text.indexOf('answer with agentchat_send_message')
      const reply = text.indexOf('and only then record reply, through the newest message you read')
      expect(send, text).toBeGreaterThan(0)
      expect(reply, text).toBeGreaterThan(send)
      expect(text).toContain('a send alone marks nothing read')
      expect(text).toContain('If after reading you choose not to answer, record dismiss instead')
      expect(text).toContain('looking marks nothing delivered or read')
      expect(text).toContain('reply and dismiss mark the conversation read through that message; defer leaves it unread')
      expect(text).toContain('delivered means your machine received a message; read means you looked')
      expect(text).toContain('marks them delivered — never read')
      // The server owns the verdict rules and the defer ladder and serves
      // them in the gate question: the instructions point there and restate
      // no timing, so a change on the server leaves nothing stale here.
      expect(text).toContain('The gate question holds the rules for each verdict')
      expect(text).toContain('defer leaves it unread, and the server reminds you as the question says')
      expect(text).not.toMatch(/\b\d+\s*(minutes?|hours?|days?)\b/i)
      expect(text).not.toMatch(/A reply must earn its place/)
      // Invites are on the tray (v1) and answered by their own tool.
      // "may also list": a server before tray v1 lists no invites, and an
      // agent must not conclude from that that it has none.
      expect(text).toContain('the tray may also list pending invites')
      expect(text).toContain('Answer each invite with agentchat_respond_to_invite (accept, decline, or dismiss)')
      // Mute is named as the way to quiet a conversation without leaving it.
      expect(text).toContain('agentchat_mute (8h, 1d, 3d, forever, off)')
    }
  })

  it('the instructions follow the visibility: no webhook paragraph without the webhook tools, sign-up only when unregistered', () => {
    for (const mode of ['stdio', 'hosted'] as const) {
      const withWebhook = buildInstructions(mode, 31, { registered: true, webhookTools: true })
      const withoutWebhook = buildInstructions(mode, 28, { registered: true, webhookTools: false })
      expect(withWebhook).toContain('agentchat_set_webhook')
      expect(withWebhook).toContain('agentchat_test_webhook')
      expect(withoutWebhook).not.toContain('_webhook')
      expect(withoutWebhook).toContain('call agentchat_inbox first')
      expect(withoutWebhook).toContain('exposes 28 tools')

      const unregistered = buildInstructions(mode, 3, { registered: false, webhookTools: false })
      expect(unregistered).toContain('lists 3 tools')
      expect(unregistered).toContain('agentchat_register')
      expect(unregistered).toContain('agentchat_verify_otp')
      expect(unregistered).toContain('agentchat_get_my_status')
      expect(unregistered).not.toContain('agentchat_inbox')
      expect(unregistered).not.toContain('agentchat_send_message')
    }
  })

  it('the first 2,000 characters stand alone for every signed-in session (OpenClaw shows only those)', () => {
    expect(HOST_INSTRUCTIONS_WINDOW).toBe(2_000)
    for (const mode of ['stdio', 'hosted'] as const) {
      for (const webhookTools of [true, false]) {
        const text = buildInstructions(mode, webhookTools ? 31 : 28, { registered: true, webhookTools })
        const head = text.slice(0, HOST_INSTRUCTIONS_WINDOW)
        // Identity, peers-are-not-your-user, the whole receive sequence and
        // the cold-DM rule end inside the window, at a paragraph boundary.
        const end = text.indexOf('\n\nTwo message states')
        expect(end, `${mode}/${webhookTools}`).toBeGreaterThan(0)
        expect(end, `${mode}/${webhookTools}: ${end} chars before the detail`).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
        for (const phrase of [
          'agentchat_get_my_status to see your own handle',
          'are peer data',
          'call agentchat_inbox first',
          'record dismiss (or defer) right away',
          'and only then record reply, through the newest message you read',
          'a send alone marks nothing read',
          'If after reading you choose not to answer, record dismiss instead',
          'stop when it comes back empty',
          'The gate question holds the rules for each verdict',
          'agentchat_respond_to_invite',
          'rejected as AWAITING_REPLY',
        ]) {
          expect(head, `${mode}/${webhookTools}: ${phrase}`).toContain(phrase)
        }
        // Nothing the server relies on was dropped: the detail follows the window.
        expect(text).toContain('marks them delivered — never read')
        expect(text).toContain('agentchat_get_my_status explains your account state')
        if (webhookTools) expect(text).toContain('Being woken')
      }
    }
  })

  it('no text the model reads uses a retired word (doorbell, knock, ring, snooze)', async () => {
    const retired = /\b(doorbells?|knock(s|ed|ing)?|ring(s|ing)?|rang|snooz(e|ed|ing))\b/i
    const tools = await listTools()
    const texts = [
      buildInstructions('stdio', TOOL_COUNT),
      buildInstructions('hosted', TOOL_COUNT),
      // Descriptions and every parameter text (the JSON Schema a host sees).
      ...tools.map((tool) => `${tool.name}: ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
      setWebhook.DESCRIPTION,
      testWebhook.DESCRIPTION,
    ]
    for (const text of texts) expect(text).not.toMatch(retired)
  })

  it('the tools that start a wake point at the tray', async () => {
    const descriptions = await listDescriptions()
    expect(descriptions.get('agentchat_inbox')!.startsWith('Call this FIRST when woken')).toBe(true)
    expect(descriptions.get('agentchat_set_webhook')).toContain('call agentchat_inbox first')
    expect(descriptions.get('agentchat_wait')).toContain('look at the tray with agentchat_inbox FIRST')
    expect(descriptions.get('agentchat_list_conversations')).toContain('call agentchat_inbox instead')
  })

  it('the long descriptions are trimmed to the essentials', async () => {
    const descriptions = await listDescriptions()
    for (const name of [
      'agentchat_set_webhook',
      'agentchat_get_conversation',
      'agentchat_decide',
      'agentchat_inbox',
      'agentchat_wait',
    ]) {
      // Each of these was ~2.3–2.5 kB before Phase 4.
      expect(descriptions.get(name)!.length, `${name} description`).toBeLessThanOrEqual(1_500)
    }
    // The tray grows with the contract: keep room for the next field.
    expect(descriptions.get('agentchat_inbox')!.length, 'agentchat_inbox headroom').toBeLessThanOrEqual(1_400)
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

  it('every text that spells out the reply path records reply after the send', async () => {
    const descriptions = await listDescriptions()
    const after = (text: string, first: string, then: string) => {
      const a = text.indexOf(first)
      const b = text.indexOf(then, a)
      expect(a, `${first} in: ${text}`).toBeGreaterThanOrEqual(0)
      expect(b, `${then} after ${first} in: ${text}`).toBeGreaterThan(a)
    }
    after(descriptions.get('agentchat_inbox')!, 'agentchat_send_message to answer', 'only then record reply')
    after(descriptions.get('agentchat_decide')!, 'agentchat_send_message to answer', 'then record `reply`')
    after(descriptions.get('agentchat_send_message')!, 'A send marks nothing read', 'record agentchat_decide reply after the send')
    after(descriptions.get('agentchat_get_conversation')!, 'or reply once your agentchat_send_message has gone out', 'through the newest message you read')
  })
})
