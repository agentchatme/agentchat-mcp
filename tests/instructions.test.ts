import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import {
  buildInstructions,
  HOST_INSTRUCTIONS_WINDOW,
  spellToolNames,
  type ServerMode,
  type ToolNamer,
} from '../src/instructions.js'
import { buildMcpServer } from '../src/lib.js'
import { TOOL_NAMES, visibleToolNames, type ToolVisibility } from '../src/tools/index.js'
import { KEY } from './tools/_real-client.js'

// ─── The server instructions, pinned ───────────────────────────────────────
//
// tests/fixtures/instructions.json holds the exact instructions text of every
// composition (stdio, hosted) in every situation, as 0.5.1 served it, with
// the one-conversation exception added to the receive paragraph, the card
// anchor's fallback (last_message_id when preview is null), and room made
// inside the window: the tray look and the verdicts' read effects moved into
// the read-state paragraph (their words unchanged, after a short lead-in
// that gives "that message" its antecedent), and the sign-in sentence moves
// to the end whenever the head would not fit with it, in every spelling. The
// default build must keep producing it byte for byte.
//
// To regenerate after an INTENTIONAL text change:
//   INSTRUCTIONS_FIXTURE_WRITE=1 pnpm vitest run tests/instructions.test.ts
// The run rewrites the fixture and then fails on purpose; review the diff,
// then re-run the suite normally.

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'instructions.json')

const SITUATIONS: Array<[string, ToolVisibility | undefined]> = [
  ['full surface', undefined],
  ['unregistered', { registered: false, webhookTools: false }],
  ['registered, webhook tools', { registered: true, webhookTools: true }],
  ['registered, socket integration', { registered: true, webhookTools: false }],
]

const MODES: ServerMode[] = ['stdio', 'hosted']

function defaults(): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const mode of MODES) {
    for (const [label, visibility] of SITUATIONS) {
      texts[`${mode} / ${label}`] = buildInstructions(mode, visibleToolNames(visibility).length, visibility)
    }
  }
  return texts
}

describe('the default instructions', () => {
  it('are exactly the pinned texts', () => {
    const texts = defaults()
    if (process.env['INSTRUCTIONS_FIXTURE_WRITE'] === '1') {
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(texts, null, 2)}\n`)
      throw new Error(`fixture rewritten at ${FIXTURE_PATH}; review the diff, then re-run without INSTRUCTIONS_FIXTURE_WRITE`)
    }
    const pinned = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>
    expect(Object.keys(texts).sort()).toEqual(Object.keys(pinned).sort())
    for (const [key, text] of Object.entries(texts)) expect(text, key).toBe(pinned[key])
  })
})

// ─── A runtime's spelling of the tool names ────────────────────────────────

const OPENCLAW: ToolNamer = (tool) => `agentchat__${tool}`
const MCP_PREFIXED: ToolNamer = (tool) => `mcp__agentchat__${tool}`

/** Whole `agentchat_…` tokens of a text (a spelled name is one token too). */
function toolTokens(text: string): string[] {
  return text.match(/\b[a-z_]*agentchat_[a-z0-9_]+\b/g) ?? []
}

describe('spellToolNames', () => {
  it('spells every tool name and nothing else', () => {
    const text =
      'Call agentchat_inbox first, then agentchat_decide. Set AGENTCHAT_API_KEY, run `agentchat register`, read https://agentchat.me/skill.md; agentchat_not_a_tool stays.'
    expect(spellToolNames(text, OPENCLAW)).toBe(
      'Call agentchat__agentchat_inbox first, then agentchat__agentchat_decide. Set AGENTCHAT_API_KEY, run `agentchat register`, read https://agentchat.me/skill.md; agentchat_not_a_tool stays.',
    )
  })

  it('leaves a name that is already spelled alone (never double-prefixes)', () => {
    for (const namer of [OPENCLAW, MCP_PREFIXED]) {
      const once = spellToolNames('agentchat_inbox and agentchat_wait', namer)
      expect(spellToolNames(once, namer)).toBe(once)
    }
  })

  it('knows every tool this server declares', () => {
    for (const name of TOOL_NAMES) expect(spellToolNames(name, OPENCLAW)).toBe(`agentchat__${name}`)
  })
})

describe('the instructions in a runtime\'s spelling', () => {
  it('the identity namer gives the pinned default texts exactly', () => {
    const pinned = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>
    for (const mode of MODES) {
      for (const [label, visibility] of SITUATIONS) {
        const text = buildInstructions(mode, visibleToolNames(visibility).length, visibility, (tool) => tool)
        expect(text, `${mode} / ${label}`).toBe(pinned[`${mode} / ${label}`])
      }
    }
  })

  for (const [spelling, namer] of [
    ['openclaw', OPENCLAW],
    ['mcp__agentchat__', MCP_PREFIXED],
  ] as const) {
    it(`${spelling}: every tool name is spelled, and the text is otherwise the default`, () => {
      const pinned = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>
      for (const mode of MODES) {
        for (const [label, visibility] of SITUATIONS) {
          const key = `${mode} / ${label}`
          const text = buildInstructions(mode, visibleToolNames(visibility).length, visibility, namer)
          // No declared name is left bare: every tool token is spelled.
          for (const token of toolTokens(text)) {
            expect(TOOL_NAMES.map(namer), `${key}: ${token}`).toContain(token)
          }
          // Same paragraphs as the default, names spelled; at most the
          // sign-in sentence has moved (see the next test).
          const paragraphs = (t: string) => t.split('\n\n').flatMap((p) => p.split(/(?<=\.) (?=If a tool returns NOT_)/))
          expect([...paragraphs(text)].sort(), key).toEqual(
            [...paragraphs(spellToolNames(pinned[key]!, namer))].sort(),
          )
        }
      }
    })

    it(`${spelling}: when the spelled head runs past the window, the sign-in sentence moves to the end`, () => {
      for (const mode of MODES) {
        for (const webhookTools of [true, false]) {
          const visibility = { registered: true, webhookTools }
          const count = visibleToolNames(visibility).length
          const declared = buildInstructions(mode, count, visibility)
          const spelled = buildInstructions(mode, count, visibility, namer)
          const headOf = (t: string) => t.slice(0, t.indexOf('\n\nTwo message states'))
          const label = `${spelling}/${mode}/${webhookTools}`
          expect(headOf(declared).length, label).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
          expect(headOf(spelled).length, label).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
          const signIn = mode === 'hosted' ? 'If a tool returns NOT_AUTHENTICATED' : 'If a tool returns NOT_REGISTERED'
          // Both spellings lengthen this head past the window, so the sentence
          // sits with the account guidance after it, just before the last
          // paragraph; the head keeps who the agent is.
          expect(headOf(spelled), label).not.toContain(signIn)
          expect(headOf(spelled), label).toContain(spellToolNames('Call agentchat_get_my_status to see your own handle and account state.', namer))
          const paragraphs = spelled.split('\n\n')
          expect(paragraphs.at(-2), label).toMatch(new RegExp(`^${signIn}`))
          // The last paragraph is the composition's account guidance, spelled.
          expect(paragraphs.at(-1), label).toBe(spellToolNames(declared.split('\n\n').at(-1)!, namer))
        }
      }
    })
  }

  it('in a runtime\'s spelling the head fits the window in every composition and situation, the full surface included', () => {
    for (const namer of [OPENCLAW, MCP_PREFIXED]) {
      for (const mode of MODES) {
        for (const [label, visibility] of SITUATIONS) {
          if (visibility && !visibility.registered) continue // the short sign-up text
          const text = buildInstructions(mode, visibleToolNames(visibility).length, visibility, namer)
          const end = text.indexOf('\n\nTwo message states')
          expect(end, `${mode} / ${label}`).toBeGreaterThan(0)
          expect(end, `${mode} / ${label}`).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
          expect(text.slice(0, HOST_INSTRUCTIONS_WINDOW), `${mode} / ${label}`).toContain('rejected as AWAITING_REPLY')
        }
      }
    }
    // The hosted full surface keeps its sign-up hint, after the window.
    const hosted = buildInstructions('hosted', visibleToolNames(undefined).length, undefined, OPENCLAW)
    expect(hosted.slice(hosted.indexOf('\n\nTwo message states'))).toContain('No account yet? Call agentchat__agentchat_register')
  })

  it('one rule in every spelling, the declared one included: the sign-in sentence stays in the head exactly when the head still fits with it', () => {
    for (const namer of [undefined, OPENCLAW, MCP_PREFIXED]) {
      for (const mode of MODES) {
        for (const [label, visibility] of SITUATIONS) {
          if (visibility && !visibility.registered) continue // the short sign-up text
          const key = `${namer ? namer('x') : 'declared'}/${mode}/${label}`
          const text = buildInstructions(mode, visibleToolNames(visibility).length, visibility, namer)
          const end = text.indexOf('\n\nTwo message states')
          expect(end, key).toBeGreaterThan(0)
          expect(end, key).toBeLessThanOrEqual(HOST_INSTRUCTIONS_WINDOW)
          const signInStart = text.indexOf(mode === 'hosted' ? 'If a tool returns NOT_AUTHENTICATED' : 'If a tool returns NOT_REGISTERED')
          if (signInStart < end) continue // it fits, so it stayed
          // It moved: the sentence (up to its paragraph end) would have pushed the head past the window.
          const signInEnd = text.indexOf('\n\n', signInStart)
          const sentence = text.slice(signInStart, signInEnd === -1 ? undefined : signInEnd)
          expect(end + 1 + sentence.length, key).toBeGreaterThan(HOST_INSTRUCTIONS_WINDOW)
        }
      }
    }
  })
})

describe('buildMcpServer({ toolNamer })', () => {
  async function served(toolNamer?: ToolNamer) {
    const server = buildMcpServer({
      apiBase: 'https://namer.agentchat.test',
      apiKey: KEY,
      selfHandle: 'me',
      visibility: { registered: true, webhookTools: false },
      ...(toolNamer ? { toolNamer } : {}),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'namer', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      return { instructions: client.getInstructions() ?? '', names: (await client.listTools()).tools.map((t) => t.name) }
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('without one: the declared names, exactly as before', async () => {
    const { instructions, names } = await served()
    const visibility = { registered: true, webhookTools: false }
    expect(instructions).toBe(buildInstructions('hosted', visibleToolNames(visibility).length, visibility))
    expect(instructions).toContain('call agentchat_inbox first')
    expect(names).toEqual(visibleToolNames(visibility))
  })

  it('with one: the instructions are spelled for the runtime; tools/list is unchanged', async () => {
    const { instructions, names } = await served(OPENCLAW)
    const visibility = { registered: true, webhookTools: false }
    expect(instructions).toBe(buildInstructions('hosted', visibleToolNames(visibility).length, visibility, OPENCLAW))
    expect(instructions).toContain('call agentchat__agentchat_inbox first')
    expect(instructions).not.toMatch(/(?<![a-z_])agentchat_inbox/)
    expect(names).toEqual(visibleToolNames(visibility))
  })

  it('refuses a namer that does not return a valid MCP tool name, at build time', () => {
    const build = (toolNamer: unknown) => () =>
      buildMcpServer({ apiBase: 'https://namer.agentchat.test', apiKey: null, toolNamer: toolNamer as ToolNamer })
    expect(build('agentchat__')).toThrow(/toolNamer must be a function/)
    expect(build(() => '')).toThrow(/valid MCP tool name/)
    expect(build((tool: string) => `agentchat :: ${tool}`)).toThrow(/valid MCP tool name/)
    expect(build((tool: string) => `x`.repeat(120) + tool)).toThrow(/valid MCP tool name/)
    expect(build(() => undefined)).toThrow(/valid MCP tool name/)
    expect(
      build(() => {
        throw new Error('boom')
      }),
    ).toThrow(/toolNamer threw for agentchat_send_message: boom/)
    expect(build(OPENCLAW)).not.toThrow()
    expect(build(MCP_PREFIXED)).not.toThrow()
  })
})
