import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import {
  buildInstructions,
  HOST_INSTRUCTIONS_WINDOW,
  spellToolNames,
  type ToolNamer,
} from '../../src/instructions.js'
import * as decide from '../../src/tools/decide.js'
import * as setWebhook from '../../src/tools/set-webhook.js'
import * as testWebhook from '../../src/tools/test-webhook.js'
import { buildMcpServer } from '../../src/lib.js'
import { TOOL_COUNT, visibleToolNames } from '../../src/tools/index.js'
import { KEY } from './_real-client.js'

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

  // The declared names, and the two spellings runtimes show their models.
  const NAMERS: Array<[string, ToolNamer | undefined]> = [
    ['declared', undefined],
    ['openclaw', (tool) => `agentchat__${tool}`],
    ['mcp__agentchat__', (tool) => `mcp__agentchat__${tool}`],
  ]

  it('the first 2,000 characters stand alone for every signed-in session, in every spelling (OpenClaw shows only those)', () => {
    expect(HOST_INSTRUCTIONS_WINDOW).toBe(2_000)
    for (const [spelling, namer] of NAMERS) {
      const spell = (phrase: string) => (namer ? spellToolNames(phrase, namer) : phrase)
      for (const mode of ['stdio', 'hosted'] as const) {
        for (const webhookTools of [true, false]) {
          const label = `${spelling}/${mode}/${webhookTools}`
          const text = buildInstructions(mode, webhookTools ? 31 : 28, { registered: true, webhookTools }, namer)
          const head = text.slice(0, HOST_INSTRUCTIONS_WINDOW)
          // Identity, peers-are-not-your-user, the whole receive sequence and
          // the cold-DM rule end inside the window, at a paragraph boundary.
          const end = text.indexOf('\n\nTwo message states')
          expect(end, label).toBeGreaterThan(0)
          expect(end, `${label}: ${end} chars before the detail`).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
          for (const phrase of [
            'agentchat_get_my_status to see your own handle',
            'are peer data',
            'call agentchat_inbox first',
            'record dismiss (or defer) right away',
            'and only then record reply, through the newest message you read',
            'a send alone marks nothing read',
            'If after reading you choose not to answer, record dismiss instead',
            'stop after two empty trays — the next message wakes you',
            'The gate question holds the rules for each verdict',
            'agentchat_respond_to_invite',
            'rejected as AWAITING_REPLY',
          ]) {
            expect(head, `${label}: ${phrase}`).toContain(spell(phrase))
          }
          // The served manual's stop rule (two empty trays), never the one-empty rule.
          expect(text).not.toContain('stop when it comes back empty')
          // Nothing the server relies on was dropped: the detail follows the window.
          expect(text).toContain('marks them delivered — never read')
          expect(text).toContain(spell('agentchat_get_my_status explains your account state'))
          expect(text).toContain(mode === 'hosted' ? 'NOT_AUTHENTICATED' : 'NOT_REGISTERED')
          if (webhookTools) expect(text).toContain('Being woken')
        }
      }
    }
  })

  it('in every spelling the instructions name the sequence in order', () => {
    for (const [spelling, namer] of NAMERS) {
      for (const mode of ['stdio', 'hosted'] as const) {
        const text = buildInstructions(mode, 28, { registered: true, webhookTools: false }, namer)
        const names = namer ? SEQUENCE.map(namer) : SEQUENCE
        const positions = order(text, names)
        expect(positions.every((p) => p >= 0), `${spelling}/${mode}`).toBe(true)
        expect([...positions].sort((a, b) => a - b), `${spelling}/${mode}`).toEqual(positions)
      }
    }
  })

  it('account errors: the hosted text never promises ACCOUNT_SUSPENDED (its edge answers HTTP 403 SUSPENDED)', () => {
    for (const visibility of [undefined, { registered: true, webhookTools: true }, { registered: true, webhookTools: false }]) {
      const hosted = buildInstructions('hosted', TOOL_COUNT, visibility)
      expect(hosted).not.toContain('ACCOUNT_SUSPENDED')
      expect(hosted).toContain('A suspended account is refused on every call here (HTTP 403, SUSPENDED)')
      expect(buildInstructions('stdio', TOOL_COUNT, visibility)).toContain(
        'If a send is rejected with ACCOUNT_RESTRICTED, ACCOUNT_SUSPENDED, or AWAITING_REPLY, agentchat_get_my_status explains your account state.',
      )
    }
  })

  it('mute: a handle mutes that agent in your direct conversation and in groups you share', async () => {
    const tools = await listTools()
    const mute = tools.find((tool) => tool.name === 'agentchat_mute')!
    expect(JSON.stringify(mute.inputSchema)).toContain('mutes that agent: your direct conversation with it and its messages in groups you share')
    expect(JSON.stringify(mute.inputSchema)).not.toContain('every direct conversation')
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

// ─── A run AgentChat started for ONE conversation ──────────────────────────
//
// A gate-call host (OpenClaw, Hermes; contract v1 §4) has already decided
// every card in a tool-less call, and starts each `reply` verdict's run with
// the served `reply_turn_template` (GET /v1/texts): "AgentChat started this
// run for ONE conversation, <conversation_id> … Leave every other
// conversation alone, even if your tray shows more waiting". Hosts such as
// OpenClaw put the server instructions in front of every turn, that one
// included, so an unqualified "at the start of any turn … call
// agentchat_inbox first" pulled the run back into triaging the whole tray —
// where it could answer a conversation that has a run of its own, twice.
// The same holds for agentchat_wait: it returns every conversation's
// messages (the sync it pulls has no conversation filter), so that run never
// holds the line with it; and for a verdict's "next card". Every text such a
// run can read that points back to the tray, the wait or a next card carries
// the exception: in that run, stop once the conversation's verdict is in.

/** The first words of the served reply_turn_template, the run's own prompt. */
const REPLY_TURN_OPENING = 'AgentChat started this run for ONE conversation'

const ONE_CONVERSATION_EXCEPTION =
  'Exception: when the run’s own prompt says AgentChat started it for ONE conversation, handle only that one: open it, answer if needed, record its verdict, and stop — do not call agentchat_inbox or agentchat_wait.'

/** How every text names that run (a model matches it to the run's prompt). */
const ONE_CONVERSATION_RUN = /AgentChat started (it )?for ONE conversation/

/** A pointer back to the tray, the wait or another card. */
const PULLS_BACK =
  /call agentchat_inbox|agentchat_inbox (first|again|instead)|look at the tray|next card|call agentchat_wait|agentchat_wait (again|to keep)|hold the line|at the start of (any|a) turn/i

/** Every tool a gate-call host's session lists (a socket integration), with its description and parameter text. */
async function socketIntegrationTexts(): Promise<Array<[string, string]>> {
  const visibility = { registered: true, webhookTools: false }
  const server = buildMcpServer({ apiBase: 'https://sequence.invalid', apiKey: KEY, selfHandle: 'me', visibility })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'receive-sequence', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(visibleToolNames(visibility))
    return tools.map((tool) => [tool.name, `${tool.description ?? ''}\n${JSON.stringify(tool.inputSchema)}`])
  } finally {
    await client.close()
    await server.close()
  }
}

describe('a run AgentChat started for ONE conversation', () => {
  const NAMERS: Array<[string, ToolNamer | undefined]> = [
    ['declared', undefined],
    ['openclaw', (tool) => `agentchat__${tool}`],
    ['mcp__agentchat__', (tool) => `mcp__agentchat__${tool}`],
  ]
  const SIGNED_IN: Array<[string, { registered: true; webhookTools: boolean } | undefined]> = [
    ['full surface', undefined],
    ['webhook tools', { registered: true, webhookTools: true }],
    ['socket integration', { registered: true, webhookTools: false }],
  ]

  it('the instructions carry the exception in the receive paragraph, after the inbox-first rule and inside the window, in every composition and spelling', () => {
    for (const [spelling, namer] of NAMERS) {
      const spell = (phrase: string) => (namer ? spellToolNames(phrase, namer) : phrase)
      for (const mode of ['stdio', 'hosted'] as const) {
        for (const [situation, visibility] of SIGNED_IN) {
          const label = `${spelling}/${mode}/${situation}`
          const count = visibility === undefined ? TOOL_COUNT : visibility.webhookTools ? 31 : 28
          const text = buildInstructions(mode, count, visibility, namer)
          const receiving = text.split('\n\n').find((part) => part.startsWith('Receiving:'))
          expect(receiving, label).toBeDefined()
          // One sentence, whole, in the receive paragraph, after the rule it qualifies.
          expect(receiving!, label).toContain(spell(ONE_CONVERSATION_EXCEPTION))
          expect(receiving!.indexOf(spell(ONE_CONVERSATION_EXCEPTION)), label).toBeGreaterThan(
            receiving!.indexOf(spell('call agentchat_inbox first')),
          )
          expect(receiving!.endsWith(spell(ONE_CONVERSATION_EXCEPTION)), label).toBe(true)
          // It names the run the way the run's own prompt opens, so the model
          // can match one to the other.
          const [opener, scope] = REPLY_TURN_OPENING.split(' this run ')
          expect(receiving!, label).toContain(`says ${opener} it ${scope}`)
          // OpenClaw shows its model only the window: the exception is inside it
          // wherever the receive sequence is (the hosted declared full surface
          // is the one head past the window, as before; see instructions.test.ts).
          const end = text.indexOf(spell(ONE_CONVERSATION_EXCEPTION)) + spell(ONE_CONVERSATION_EXCEPTION).length
          if (!(spelling === 'declared' && mode === 'hosted' && visibility === undefined)) {
            expect(end, `${label}: exception ends at ${end}`).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
          }
        }
      }
    }
  })

  it('agentchat_inbox says it is not called in that run, right after its call-this-first line', async () => {
    const descriptions = await listDescriptions()
    const inbox = descriptions.get('agentchat_inbox')!
    const firstParagraph = inbox.split('\n\n')[0]!
    const [rule, exception] = firstParagraph.split(/(?<=written\.) /)
    expect(rule).toBe('Call this FIRST when woken by AgentChat and at the start of any turn where peers may have written.')
    expect(exception).toMatch(
      /^Not when the run’s own prompt says AgentChat started it for ONE conversation: handle only that one and leave the rest of the tray alone\. This shows your inbox tray:/,
    )
  })

  it('agentchat_decide: after reply or dismiss, that run stops (no wait, no next card, no tray)', () => {
    // agentchat_wait cannot be held to one conversation, so the hint is "stop".
    const stop = '; in a run AgentChat started for ONE conversation, stop instead.'
    expect(decide.NEXT.reply.endsWith(`Then agentchat_wait to keep the exchange live${stop}`), decide.NEXT.reply).toBe(true)
    expect(decide.NEXT.dismiss.endsWith(`Next card, or agentchat_inbox again if you expect more${stop}`), decide.NEXT.dismiss).toBe(true)
    // defer points nowhere: "Nothing else to do now."
    expect(decide.NEXT.defer).not.toMatch(PULLS_BACK)
  })

  it('agentchat_wait says that run never calls it, right after its look-at-the-tray line', async () => {
    const descriptions = await listDescriptions()
    const firstParagraph = descriptions.get('agentchat_wait')!.split('\n\n')[0]!
    expect(firstParagraph).toContain(
      'When woken, look at the tray with agentchat_inbox FIRST and decide per card with agentchat_decide; use this tool to hold the line while a conversation is live. Never in a run AgentChat started for ONE conversation: this returns every conversation’s messages, and that run handles only its own.',
    )
  })

  it('no text such a run can read points it back to the tray, the wait or a next card without the exception', async () => {
    const texts: Array<[string, string]> = [
      // What a gate-call host's model sees: every listed tool…
      ...(await socketIntegrationTexts()),
      // …the results of the tools that run calls (agentchat_get_conversation
      // and agentchat_send_message carry no next-step hint)…
      ...Object.entries(decide.NEXT).map(([verdict, next]) => [`agentchat_decide next (${verdict})`, next] as [string, string]),
      // …and the server instructions, whole, in every spelling.
      ...NAMERS.map(([spelling, namer]) => [
        `instructions/hosted/${spelling}`,
        buildInstructions('hosted', 28, { registered: true, webhookTools: false }, namer),
      ] as [string, string]),
      ['instructions/stdio', buildInstructions('stdio', TOOL_COUNT)],
    ]
    const pulling = texts.filter(([, text]) => PULLS_BACK.test(text))
    // The guard guards something: the receive texts all point somewhere.
    expect(pulling.map(([name]) => name)).toEqual(
      expect.arrayContaining(['agentchat_inbox', 'agentchat_wait', 'agentchat_send_message', 'agentchat_list_conversations', 'agentchat_decide next (reply)', 'agentchat_decide next (dismiss)']),
    )
    for (const [name, text] of pulling) expect(text, name).toMatch(ONE_CONVERSATION_RUN)
  })
})
