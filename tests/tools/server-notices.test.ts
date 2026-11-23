import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { RateLimitedError } from 'agentchatme'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMcpServer, type BuildMcpServerOptions, type ServerNotice } from '../../src/lib.js'
import { Semaphore } from '../../src/semaphore.js'
import { NOTICE_LINE_PREFIX, withErrorBoundary, type SuccessShape } from '../../src/tools/_handler.js'
import { RETIRED_TOOL_NAMES, TOOL_NAMES } from '../../src/tools/index.js'
import { KEY } from './_real-client.js'

// ─── The host server's notices, on every tool result ───────────────────────
//
// A hosted endpoint passes the notices AgentChat has for a session
// (BuildMcpServerOptions.notices — e.g. the agent's wake trigger keeps
// failing) so they reach an agent that never looks at its tray. The pins:
// (1) how each result shape shows them (JSON: a top-level `notices` before
// `next`; text and errors: trailing "AgentChat notice:" lines; an already-
// shaped result: one more text block, its own content untouched); (2) no
// notices → byte-identical results; (3) every tool and retired alias shows
// them; (4) the option is checked and copied at build time.

const WAKE_FAILING: ServerNotice = {
  kind: 'wake_failing',
  since: '2026-11-22T10:00:00.000Z',
  last_at: '2026-11-22T10:35:00.000Z',
  status: 400,
  text: 'Your wake trigger has failed since 2026-11-22 10:00 UTC (HTTP 400), so AgentChat cannot wake you. Fix it, or set it again with agentchat_set_webhook.',
}
const SECOND: ServerNotice = { kind: 'second_notice', text: 'A second thing about your account.' }

const LINE = `${NOTICE_LINE_PREFIX}${WAKE_FAILING.text}`
const LINES = `${LINE}\n${NOTICE_LINE_PREFIX}${SECOND.text}`

function meta(notices?: readonly ServerNotice[]) {
  return {
    toolName: 'test',
    logger: pino({ level: 'silent' }),
    args: {},
    semaphore: new Semaphore(10),
    inflight: new Set<Promise<unknown>>(),
    ...(notices !== undefined ? { notices } : {}),
  }
}

const run = (notices: readonly ServerNotice[] | undefined, body: () => Promise<SuccessShape>) =>
  withErrorBoundary(meta(notices), body)

function texts(result: CallToolResult): string[] {
  return result.content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`))
}

describe('withErrorBoundary: how each result shows the notices', () => {
  it('a text result ends with one "AgentChat notice:" line per notice, after a blank line', async () => {
    const result = await run([WAKE_FAILING, SECOND], async () => 'Sent.')
    expect(result.content).toEqual([{ type: 'text', text: `Sent.\n\n${LINES}` }])
    expect(result.isError).toBeUndefined()
  })

  it('a JSON result gets a top-level `notices`, the notices as given, just before `next`', async () => {
    const result = await run([WAKE_FAILING], async () => ({ type: 'json', value: { ok: true, messages: [], next: 'Do X.' } }))
    expect(result.content).toHaveLength(1)
    const value = JSON.parse(texts(result)[0]!) as Record<string, unknown>
    expect(value).toEqual({ ok: true, messages: [], notices: [WAKE_FAILING], next: 'Do X.' })
    expect(Object.keys(value)).toEqual(['ok', 'messages', 'notices', 'next'])
    // Pretty-printed as before.
    expect(texts(result)[0]).toBe(JSON.stringify(value, null, 2))
  })

  it('a JSON result without `next` gets `notices` last', async () => {
    const result = await run([WAKE_FAILING, SECOND], async () => ({ type: 'json', value: { ok: true, id: 'x' } }))
    const value = JSON.parse(texts(result)[0]!) as Record<string, unknown>
    expect(Object.keys(value)).toEqual(['ok', 'id', 'notices'])
    expect(value['notices']).toEqual([WAKE_FAILING, SECOND])
  })

  it('a JSON result that already carries `notices` (the tray’s) keeps them in place and adds only the ones not shown', async () => {
    const trays = [{ ...WAKE_FAILING }, { kind: 'tray_only', text: 'From the tray.' }]
    const result = await run([{ kind: WAKE_FAILING.kind, text: WAKE_FAILING.text }, SECOND], async () => ({
      type: 'json',
      value: { conversations: [], notices: trays, next: 'Stop.' },
    }))
    const value = JSON.parse(texts(result)[0]!) as Record<string, unknown>
    expect(value['notices']).toEqual([...trays, SECOND])
    expect(Object.keys(value)).toEqual(['conversations', 'notices', 'next'])
  })

  it('a JSON value that is not an object keeps its block; the lines follow in one more text block', async () => {
    const result = await run([WAKE_FAILING], async () => ({ type: 'json', value: [1, 2] }))
    expect(texts(result)).toEqual([JSON.stringify([1, 2], null, 2), LINE])
  })

  it('an already-shaped result keeps every block untouched (a file’s text stays the file’s) and gets one more text block', async () => {
    const shaped: CallToolResult = {
      content: [
        { type: 'text', text: '{"ok":true,"shown":"text"}' },
        { type: 'text', text: 'the file text, which must not change' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
    }
    const result = await run([WAKE_FAILING], async () => shaped)
    expect(result.content.slice(0, 3)).toEqual(shaped.content)
    expect(result.content[3]).toEqual({ type: 'text', text: LINE })
    expect(result.content).toHaveLength(4)

    const refused = await run([WAKE_FAILING], async () => ({
      isError: true,
      content: [{ type: 'text', text: 'Error: VALIDATION_ERROR\n\nbad' }],
    }))
    expect(refused.isError).toBe(true)
    expect(texts(refused)).toEqual(['Error: VALIDATION_ERROR\n\nbad', LINE])
  })

  it('an error ends with the lines, after the retry hint', async () => {
    const result = await run([WAKE_FAILING], async () => {
      throw new RateLimitedError({ code: 'RATE_LIMITED', message: 'slow down' }, 429, 5_000)
    })
    expect(result.isError).toBe(true)
    const text = texts(result)[0]!
    expect(text.startsWith('Error: RATE_LIMITED\n\n')).toBe(true)
    expect(text.endsWith(`Retry after: 5 seconds.\n\n${LINE}`)).toBe(true)
  })

  it('no notices (absent or empty): every shape is exactly what it was', async () => {
    const bodies: Array<() => Promise<SuccessShape>> = [
      async () => 'Sent.',
      async () => ({ type: 'json', value: { ok: true, next: 'Do X.' } }),
      async () => ({ type: 'json', value: { notices: ['the tool’s own'], next: 'x' } }),
      async () => ({ type: 'json', value: [1] }),
      async () => ({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
      async () => {
        throw new RateLimitedError({ code: 'RATE_LIMITED', message: 'slow down' }, 429, 5_000)
      },
      async () => {
        throw new Error('boom')
      },
    ]
    for (const body of bodies) {
      const without = await run(undefined, body)
      expect(await run([], body)).toStrictEqual(without)
    }
    expect(texts(await run(undefined, bodies[0]!))).toEqual(['Sent.'])
  })
})

// ─── Through the public composition ────────────────────────────────────────

const API_BASE = 'https://notices.agentchat.test'

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

async function connect(options: Partial<BuildMcpServerOptions>) {
  const server = buildMcpServer({ apiBase: API_BASE, apiKey: KEY, selfHandle: 'me', ...options })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'server-notices', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/**
 * GET /v1/inbox answers this tray, GET /v1/messages/conv_1 this page, and
 * anything else a 400 (an error no client retries, so every call is quick).
 */
function answer(url: string): Response {
  const path = new URL(url).pathname
  if (path === '/v1/inbox') {
    return json(200, { version: 1, you: '@me', question: 'Q', conversations: [], invites: [], deferred: 0, truncated: false, waited_ms: null })
  }
  if (path === '/v1/messages/conv_1') {
    return json(200, [
      { id: 'msg_2', conversation_id: 'conv_1', sender: 'peer', seq: 2, type: 'text', content: { text: 'answer' }, metadata: {}, status: 'delivered', created_at: '2026-11-22T10:00:02.000Z' },
    ])
  }
  return json(400, { code: 'VALIDATION_ERROR', message: 'refused by the test server' })
}

function stubNetwork() {
  vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0]) =>
    answer(String(input instanceof Request ? input.url : input))) as typeof fetch)
}

/** A call per result shape: JSON (tray, conversation), an already-shaped refusal, a server error. */
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['agentchat_inbox', { timeout_seconds: 0 }],
  ['agentchat_get_conversation', { conversation_id: 'conv_1' }],
  ['agentchat_mute', { target: 'not a target!', duration: '8h' }],
  ['agentchat_get_my_status', {}],
]

describe('buildMcpServer({ notices })', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('without notices, or with none, every result is byte-identical', async () => {
    stubNetwork()
    const plain = await connect({})
    const empty = await connect({ notices: [] })
    try {
      for (const [name, args] of CALLS) {
        const a = await plain.call(name, args)
        const b = await empty.call(name, args)
        expect(b, name).toStrictEqual(a)
        expect(JSON.stringify(a), name).not.toContain(NOTICE_LINE_PREFIX)
        expect(JSON.stringify(a), name).not.toContain('"notices"')
      }
    } finally {
      await plain.close()
      await empty.close()
    }
  })

  it('with notices, each result shape shows them; nothing else changes', async () => {
    stubNetwork()
    const plain = await connect({})
    const noticed = await connect({ notices: [WAKE_FAILING] })
    try {
      // The tray: `notices` before `next`, and the boundary says they are the server's words.
      const tray = JSON.parse(texts(await noticed.call('agentchat_inbox', { timeout_seconds: 0 }))[0]!) as Record<string, unknown>
      expect(tray['notices']).toEqual([WAKE_FAILING])
      expect(Object.keys(tray).slice(-2)).toEqual(['notices', 'next'])
      expect(String(tray['security_boundary'])).toContain('`notices` are AgentChat’s own words about your account')

      // A conversation read: the same JSON plus `notices`, before its `next`.
      const before = JSON.parse(texts(await plain.call('agentchat_get_conversation', { conversation_id: 'conv_1' }))[0]!) as Record<string, unknown>
      const after = JSON.parse(texts(await noticed.call('agentchat_get_conversation', { conversation_id: 'conv_1' }))[0]!) as Record<string, unknown>
      expect(Object.keys(after)).toEqual([...Object.keys(before).filter((key) => key !== 'next'), 'notices', 'next'])
      const { notices, ...rest } = after
      expect(rest).toEqual(before)
      expect(notices).toEqual([WAKE_FAILING])

      // An already-shaped refusal: its block untouched, the line in one more.
      const refusedPlain = await plain.call('agentchat_mute', { target: 'not a target!', duration: '8h' })
      const refused = await noticed.call('agentchat_mute', { target: 'not a target!', duration: '8h' })
      expect(refused.isError).toBe(true)
      expect(refused.content).toEqual([...refusedPlain.content, { type: 'text', text: LINE }])

      // A server error: its text, then the line.
      const failedPlain = await plain.call('agentchat_get_my_status', {})
      const failed = await noticed.call('agentchat_get_my_status', {})
      expect(failed.isError).toBe(true)
      expect(texts(failed)).toEqual([`${texts(failedPlain)[0]}\n\n${LINE}`])
    } finally {
      await plain.close()
      await noticed.close()
    }
  })

  // One valid call for every tool and retired alias: each must reach its
  // handler (so the schema accepts it) and show the notice, whatever it
  // answers. Adding a tool means adding it here.
  const EVERY_TOOL: Record<string, Record<string, unknown>> = {
    agentchat_send_message: { to: '@peer', text: 'hi' },
    agentchat_list_conversations: {},
    agentchat_get_conversation: { conversation_id: 'conv_1' },
    agentchat_mark_read: { message_id: 'msg_1' },
    agentchat_get_my_status: {},
    agentchat_list_contacts: {},
    agentchat_add_contact: { handle: '@peer' },
    agentchat_remove_contact: { handle: '@peer' },
    agentchat_get_agent_profile: { handle: '@peer' },
    agentchat_block_agent: { handle: '@peer' },
    agentchat_unblock_agent: { handle: '@peer' },
    agentchat_report_agent: { handle: '@peer' },
    agentchat_create_group: { name: 'Room' },
    agentchat_get_group: { group_id: 'grp_1' },
    agentchat_list_group_invites: {},
    agentchat_respond_to_invite: { invite_id: 'inv_1', response: 'accept' },
    agentchat_leave_group: { group_id: 'grp_1' },
    agentchat_register: { email: 'owner@example.com', handle: 'fresh-bot' },
    agentchat_verify_otp: { pending_id: 'pend_1', code: '123456' },
    agentchat_set_webhook: { url: 'https://hooks.example.com/wake', secret: 's3cret-value-0123456789' },
    agentchat_clear_webhook: {},
    agentchat_wait: { timeout_seconds: 0 },
    agentchat_test_webhook: {},
    agentchat_decide: { conversation_id: 'conv_1', decision: 'dismiss', through_message_id: 'msg_1' },
    agentchat_inbox: { timeout_seconds: 0 },
    agentchat_mute: { target: 'conv_1', duration: '8h' },
    agentchat_update_group: { group_id: 'grp_1', name: 'New name' },
    agentchat_manage_members: { group_id: 'grp_1', action: 'add', handles: ['@peer'] },
    agentchat_delete_group: { group_id: 'grp_1' },
    agentchat_search_agents: { query: 'ab' },
    agentchat_delete_message: { message_id: 'msg_1' },
    agentchat_update_profile: { display_name: 'Me' },
    agentchat_send_file: { to: '@peer', bytes: 'aGk=', filename: 'hi.txt' },
    agentchat_download_file: { attachment_id: 'att_1' },
    agentchat_create_claim_link: {},
    agentchat_release_claim: {},
    agentchat_set_wake_check: {},
    agentchat_clear_wake_check: {},
    agentchat_create_wake_link: { dialect: 'openclaw' },
    agentchat_end_connection: { connection_id: 'con_1' },
    agentchat_list_inbox: {},
    agentchat_accept_group_invite: { invite_id: 'inv_1' },
    agentchat_reject_group_invite: { invite_id: 'inv_1' },
  }

  it('every tool and every retired alias shows the notice', async () => {
    expect(Object.keys(EVERY_TOOL).sort()).toEqual([...TOOL_NAMES, ...RETIRED_TOOL_NAMES].sort())
    stubNetwork()
    const session = await connect({ notices: [WAKE_FAILING] })
    try {
      const missing: string[] = []
      for (const [name, args] of Object.entries(EVERY_TOOL)) {
        const result = await session.call(name, args)
        const shown = JSON.stringify(result)
        if (!shown.includes(JSON.stringify(LINE).slice(1, -1)) && !shown.includes('wake_failing')) {
          missing.push(`${name}: ${texts(result).join(' | ').slice(0, 200)}`)
        }
      }
      expect(missing).toEqual([])
    } finally {
      await session.close()
    }
  })

  it('an unauthenticated session shows them on its NOT_AUTHENTICATED answers too', async () => {
    const session = await connect({ apiKey: null, selfHandle: undefined, notices: [WAKE_FAILING] })
    try {
      const text = texts(await session.call('agentchat_list_contacts', {}))[0]!
      expect(text).toContain('NOT_AUTHENTICATED')
      expect(text.endsWith(`\n\n${LINE}`)).toBe(true)
    } finally {
      await session.close()
    }
  })

  it('keeps a copy: changing the array or a notice after build changes nothing', async () => {
    stubNetwork()
    const notices = [{ ...WAKE_FAILING }]
    const session = await connect({ notices })
    try {
      notices[0]!.text = 'changed'
      notices.push({ ...SECOND })
      const tray = JSON.parse(texts(await session.call('agentchat_inbox', { timeout_seconds: 0 }))[0]!) as Record<string, unknown>
      expect(tray['notices']).toEqual([WAKE_FAILING])
    } finally {
      await session.close()
    }
  })

  it('refuses a malformed option at build time, naming the entry', () => {
    const build = (notices: unknown) => () =>
      buildMcpServer({ apiBase: API_BASE, apiKey: KEY, notices: notices as ServerNotice[] })
    expect(build('wake_failing')).toThrow('buildMcpServer: notices must be an array of { kind, text } objects')
    expect(build([null])).toThrow('buildMcpServer: notices[0] must be an object with a kind and a text')
    expect(build([['x']])).toThrow('notices[0] must be an object')
    expect(build([WAKE_FAILING, { text: 'no kind' }])).toThrow('buildMcpServer: notices[1].kind must be a non-empty string')
    expect(build([{ kind: ' ', text: 'x' }])).toThrow('notices[0].kind must be a non-empty string')
    expect(build([{ kind: 'x' }])).toThrow('buildMcpServer: notices[0].text must be a non-empty string')
    expect(build([{ kind: 'x', text: '' }])).toThrow('notices[0].text must be a non-empty string')
    expect(build([{ kind: 'x', text: 'y', n: 1n }])).toThrow('buildMcpServer: notices[0] must be plain JSON')
    expect(build([WAKE_FAILING])).not.toThrow()
    expect(build([])).not.toThrow()
  })
})
