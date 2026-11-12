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
import * as inbox from '../../src/tools/inbox.js'
import { CARD_ANCHOR, ONE_CONVERSATION_RUN, REPLY_TURN_OPENING } from '../../src/tools/_texts.js'
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
// holds the line with it; and for a verdict's "next card". Every sentence
// such a run can read that points back to the tray, the wait or a next card
// carries the exception — in that run, stop once the conversation's verdict
// is in — naming the run by its prompt's opening words: a run a wake started
// was started by AgentChat too, and may name a single conversation, but its
// prompt opens differently, and it keeps its receive loop.

const ONE_CONVERSATION_EXCEPTION = `Exception: in ${ONE_CONVERSATION_RUN}, handle only that one: open it, answer if needed, record its verdict, and stop — do not call agentchat_inbox or agentchat_wait.`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The exception, in any text: the run named by its prompt's opening words. */
const NAMES_THE_RUN = new RegExp(escapeRegExp(ONE_CONVERSATION_RUN))

/** A tool name in any runtime's spelling (`agentchat_inbox`, `agentchat__agentchat_inbox`, `mcp__agentchat__agentchat_inbox`). */
const spelled = (tool: string) => `(?:[a-z]+__)*${tool}`

/** A pointer back to the tray, the wait or another card. */
const PULLS_BACK = new RegExp(
  [
    `call ${spelled('agentchat_inbox')}`,
    `${spelled('agentchat_inbox')} (?:first|again|instead)`,
    `call ${spelled('agentchat_wait')}`,
    `${spelled('agentchat_wait')} (?:again|to keep)`,
    'call (?:it )?again',
    'hold the line',
    // "look again later" is what a defer means (the server reminds you), not a look now.
    'look (?:again(?! later)|at the tray)',
    '(?:back|return|go) to the tray',
    'next (?:card|conversation)',
    'at the start of (?:any|a) turn',
  ].join('|'),
  'i',
)

/** Sentences of one paragraph (a period inside "e.g." does not end one). */
function sentencesOf(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=[.!?])\s+/)
  const sentences: string[] = []
  for (const part of parts) {
    const last = sentences.at(-1)
    if (last !== undefined && /\b(?:e\.g|i\.e)\.$/.test(last)) sentences[sentences.length - 1] = `${last} ${part}`
    else sentences.push(part)
  }
  return sentences
}

/**
 * The sentences of `text` that point back to the tray, the wait or a next
 * card and are not governed by the exception. A pointer is governed when its
 * own sentence names the run; when the next sentence of its paragraph is the
 * exception (it opens "Not", "Never", "Except" or "In" and names the run);
 * when its paragraph carries an "Exception: …" sentence naming the run (the
 * instructions' receive paragraph); or, inside a tool's own description or
 * parameter text, when it points only at that tool and the description's
 * first paragraph says the run never calls it ("Not in …" / "Never in …").
 */
function ungovernedPointers(text: string, own?: { tool: string; description: string }): string[] {
  const excludesOwnTool =
    own !== undefined &&
    sentencesOf(own.description.split(/\n\s*\n/)[0]!).some((sentence) => /^(?:Not|Never) in /.test(sentence) && NAMES_THE_RUN.test(sentence))
  const found: string[] = []
  for (const paragraph of text.split(/\n\s*\n/)) {
    const sentences = sentencesOf(paragraph)
    const paragraphException = sentences.some((sentence) => sentence.startsWith('Exception:') && NAMES_THE_RUN.test(sentence))
    sentences.forEach((sentence, index) => {
      if (!PULLS_BACK.test(sentence) || NAMES_THE_RUN.test(sentence) || paragraphException) return
      const next = sentences[index + 1]
      if (next !== undefined && /^(?:Not|Never|Except|In) /.test(next) && NAMES_THE_RUN.test(next)) return
      if (excludesOwnTool) {
        const tools = sentence.match(/\b(?:[a-z]+__)*agentchat_[a-z_]+/g) ?? []
        if (tools.every((tool) => tool.endsWith(own!.tool))) return
      }
      found.push(sentence)
    })
  }
  return found
}

/** Parameter descriptions of one tool's JSON Schema. */
function parameterTexts(inputSchema: unknown): string[] {
  const properties = (inputSchema as { properties?: Record<string, { description?: unknown }> }).properties ?? {}
  return Object.values(properties).flatMap((property) => (typeof property.description === 'string' ? [property.description] : []))
}

interface ListedTool {
  name: string
  description: string
  parameters: string[]
}

async function listedTools(visibility?: { registered: true; webhookTools: boolean }): Promise<ListedTool[]> {
  const server = buildMcpServer({
    apiBase: 'https://sequence.invalid',
    apiKey: visibility ? KEY : null,
    ...(visibility ? { selfHandle: 'me', visibility } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'receive-sequence', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const { tools } = await client.listTools()
    if (visibility) expect(tools.map((tool) => tool.name)).toEqual(visibleToolNames(visibility))
    return tools.map((tool) => ({ name: tool.name, description: tool.description ?? '', parameters: parameterTexts(tool.inputSchema) }))
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

  it('every text names the run by the opening of its own prompt, the served reply_turn_template', () => {
    expect(REPLY_TURN_OPENING).toBe('AgentChat started this run for ONE conversation')
    expect(ONE_CONVERSATION_RUN).toBe('a run whose prompt opens “AgentChat started this run for ONE conversation”')
  })

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
          // One sentence, whole, closing the receive paragraph, after the rule it qualifies.
          expect(receiving!.endsWith(spell(ONE_CONVERSATION_EXCEPTION)), label).toBe(true)
          expect(receiving!.indexOf(spell(ONE_CONVERSATION_EXCEPTION)), label).toBeGreaterThan(
            receiving!.indexOf(spell('call agentchat_inbox first')),
          )
          // OpenClaw shows its model only the window: the exception ends inside it everywhere.
          const end = text.indexOf(spell(ONE_CONVERSATION_EXCEPTION)) + spell(ONE_CONVERSATION_EXCEPTION).length
          expect(end, `${label}: exception ends at ${end}`).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
        }
      }
    }
  })

  it('agentchat_inbox says it is not called in that run, right after its call-this-first line', async () => {
    const descriptions = await listDescriptions()
    const firstParagraph = descriptions.get('agentchat_inbox')!.split('\n\n')[0]!
    expect(firstParagraph.startsWith(
      `Call this FIRST when woken by AgentChat and at the start of any turn where peers may have written. Not in ${ONE_CONVERSATION_RUN}: handle only that one and leave the rest of the tray alone. This shows the tray:`,
    ), firstParagraph).toBe(true)
  })

  it('agentchat_decide: after reply or dismiss, that run stops (no wait, no next card, no tray)', () => {
    // agentchat_wait cannot be held to one conversation, so the hint is "stop".
    const stop = `; in ${ONE_CONVERSATION_RUN}, stop instead.`
    expect(decide.NEXT.reply.endsWith(`Then agentchat_wait to keep the exchange live${stop}`), decide.NEXT.reply).toBe(true)
    expect(decide.NEXT.dismiss.endsWith(`Next card, or agentchat_inbox again if you expect more${stop}`), decide.NEXT.dismiss).toBe(true)
    // defer points nowhere: "Nothing else to do now."
    expect(decide.NEXT.defer).not.toMatch(PULLS_BACK)
  })

  it('agentchat_wait says that run never calls it, right after its look-at-the-tray line', async () => {
    const descriptions = await listDescriptions()
    const firstParagraph = descriptions.get('agentchat_wait')!.split('\n\n')[0]!
    expect(firstParagraph).toContain(
      `When woken, look at the tray with agentchat_inbox FIRST and decide per card with agentchat_decide; use this tool to hold the line while a conversation is live. Never in ${ONE_CONVERSATION_RUN}: this returns every conversation’s messages, and that run handles only its own.`,
    )
  })

  it('no sentence such a run can read points it back to the tray, the wait or a next card without the exception', async () => {
    const ungoverned: string[] = []
    // What a gate-call host's model sees: every listed tool, its description and parameters…
    for (const tool of await listedTools({ registered: true, webhookTools: false })) {
      const own = { tool: tool.name, description: tool.description }
      for (const text of [tool.description, ...tool.parameters]) {
        ungoverned.push(...ungovernedPointers(text, own).map((sentence) => `${tool.name}: ${sentence}`))
      }
    }
    // …the results of the tools that run calls (agentchat_get_conversation and
    // agentchat_send_message carry no next-step hint)…
    for (const [verdict, next] of Object.entries(decide.NEXT)) {
      ungoverned.push(...ungovernedPointers(next).map((sentence) => `agentchat_decide next (${verdict}): ${sentence}`))
    }
    // …and the server instructions, whole, in every spelling.
    for (const [spelling, namer] of NAMERS) {
      for (const mode of ['stdio', 'hosted'] as const) {
        const text = buildInstructions(mode, 28, { registered: true, webhookTools: false }, namer)
        ungoverned.push(...ungovernedPointers(text).map((sentence) => `instructions/${mode}/${spelling}: ${sentence}`))
      }
    }
    expect(ungoverned).toEqual([])
  })

  it('the guard catches a pointer the exception does not govern', () => {
    // The shapes an edit could add (a second pointer in the send text, in the
    // read-state paragraph, in a verdict hint): each one is caught.
    const send = 'Send is instant. Then call agentchat_wait again to hold the line.'
    const states = `Two message states: delivered means received. agentchat_wait is the puller: call it again after you reply (never in ${ONE_CONVERSATION_RUN}). After every reply, call agentchat_wait again.`
    const hint = `${decide.NEXT.dismiss} Then return to the tray and take the next conversation.`
    expect(ungovernedPointers(send)).toEqual(['Then call agentchat_wait again to hold the line.'])
    expect(ungovernedPointers(states)).toEqual(['After every reply, call agentchat_wait again.'])
    expect(ungovernedPointers(hint)).toEqual(['Then return to the tray and take the next conversation.'])
    // The spelled names are caught too.
    expect(ungovernedPointers('Next, call mcp__agentchat__agentchat_inbox again.')).toHaveLength(1)
  })
})

// ─── A card's read anchor ──────────────────────────────────────────────────
//
// On a server with migration 104, a card whose only unread messages are
// system notices has `preview: null`; its read anchor is then
// `last_message_id`, and such a server refuses a through_message_id that is
// not a message of the conversation (404 MESSAGE_NOT_FOUND, on the verdict
// and on mark-read alike). Every sentence
// that tells the model to pass the card's preview.message_id says so.

describe('the card anchor when preview is null', () => {
  it('every sentence that names preview.message_id names last_message_id for a null preview', async () => {
    const texts: Array<[string, string]> = []
    for (const tool of await listedTools()) {
      texts.push([tool.name, tool.description], ...tool.parameters.map((text) => [`${tool.name} parameter`, text] as [string, string]))
    }
    texts.push(...Object.entries(inbox.NEXT).map(([outcome, next]) => [`agentchat_inbox next (${outcome})`, next] as [string, string]))
    texts.push(...Object.entries(decide.NEXT).map(([verdict, next]) => [`agentchat_decide next (${verdict})`, next] as [string, string]))
    for (const mode of ['stdio', 'hosted'] as const) {
      texts.push([`instructions/${mode}`, buildInstructions(mode, TOOL_COUNT)])
      texts.push([`instructions/${mode}/socket`, buildInstructions(mode, 28, { registered: true, webhookTools: false })])
    }
    const missing: string[] = []
    let named = 0
    for (const [name, text] of texts) {
      for (const paragraph of text.split(/\n\s*\n/)) {
        for (const sentence of sentencesOf(paragraph)) {
          if (!sentence.includes('preview.message_id')) continue
          named += 1
          if (!sentence.includes(CARD_ANCHOR)) missing.push(`${name}: ${sentence}`)
        }
      }
    }
    expect(missing).toEqual([])
    // instructions ×4, agentchat_inbox, its cards hint, agentchat_decide ×2,
    // agentchat_get_conversation, agentchat_mark_read ×2 at least.
    expect(named).toBeGreaterThanOrEqual(11)
  })
})
