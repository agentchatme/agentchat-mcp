import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentChatClient } from 'agentchatme'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotRegisteredError } from '../../src/client.js'
import { buildMcpServer } from '../../src/lib.js'
import { Semaphore } from '../../src/semaphore.js'
import * as registerAccount from '../../src/tools/register.js'
import * as verifyOtp from '../../src/tools/verify-otp.js'
import { factLines, flowOf, nextLine, renderFlow, type SignupFlow } from '../../src/tools/_signup.js'
import { RECOVER_THE_KEY } from '../../src/tools/_texts.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Sign-up answers: the server says the next step ────────────────────────
//
// An agent with no integration onboards through exactly these two tools, so
// what they say about an answer is the advice it gets at its first step. A
// current server's answer carries a flow object (contract v1, "Sign-up
// flows"): `next_step`, the facts, and a message safe to show verbatim. The
// tools render it — the server's message, one `Next:` line naming the tool
// for `next_step`, the facts present — and add no rulebook of their own.
//
// The cases are the contract's sign-up conformance cases
// (tests/fixtures/signup-flow.cases.json, a byte-identical copy of
// https://agentchat.me/contract/v1/conformance/signup-flow.cases.json): each
// request, the server's answer, and the flow, message and client action a
// client derives. tests/fixtures/signup-flow.texts.json holds the exact text
// the model reads for each. When the contract changes, copy its cases
// again; these tests then say which text changed (regenerate the texts with
// SIGNUP_TEXTS_WRITE=1 and review the diff).
//
// The per-code guidance the tools carried before is kept only for a server
// that sends no `next_step` (an older server); the contract's `legacy` cases
// and the last part of this file hold that fallback.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

type Kind = 'register' | 'verify' | 'recover' | 'recover_verify' | 'rotate_key' | 'rotate_key_verify'
type Action = 'done' | 'ask_code' | 'ask_param' | 'offer_new_code' | 'wait_then_retry' | 'stop' | 'legacy'

interface Case {
  name: string
  note: string
  request: { kind: Kind; method: string; path: string; body: Record<string, string> }
  response: { status: number; headers: Record<string, string>; body: Record<string, unknown> }
  expect: { action: Action; code: string | null; flow: Record<string, unknown> | null; message: string }
}

interface Cases {
  version: number
  actions: Action[]
  start_steps: Record<string, string>
  verify_steps: Record<string, string>
  wait_limit_s: number
  cases: Case[]
}

interface Texts {
  about: string
  tools: Record<string, string>
  rendered: Record<string, string>
}

const CONTRACT = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'signup-flow.cases.json'), 'utf8')) as Cases
const TEXTS_PATH = path.join(FIXTURES, 'signup-flow.texts.json')
const TEXTS = JSON.parse(fs.readFileSync(TEXTS_PATH, 'utf8')) as Texts
const CASES = CONTRACT.cases
const onTool = (c: Case) => c.request.kind === 'register' || c.request.kind === 'verify'
const TOOL_CASES = CASES.filter(onTool)
const OTHER_CASES = CASES.filter((c) => !onTool(c))
const byName = (name: string): Case => {
  const found = CASES.find((c) => c.name === name)
  if (found === undefined) throw new Error(`no contract case ${name}`)
  return found
}

/** The flow fields these tools read beside the contract's flow: the existing details they render. */
const DETAIL_FIELDS = ['limit', 'handles'] as const
/** The flow fields these tools read; every other field is ignored. */
const READ_FIELDS = ['next_step', 'status', 'pending_id', 'param', 'code_length', 'retry_after_s'] as const

function pick(source: Record<string, unknown> | null | undefined, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((f) => source?.[f] !== undefined).map((f) => [f, source![f]]))
}

const flowSource = (body: Record<string, unknown>) =>
  (typeof body['code'] === 'string' ? body['details'] : body) as Record<string, unknown> | null | undefined

/**
 * The codes each tool's route answers with: the contract's cases for that
 * request kind (a `future-` case is a code no server sends yet), plus the
 * codes the route sends that the contract shows on another route only: the
 * verify step can also hit the email caps, when another registration with
 * the email finished after this code was sent (409, as at register).
 */
function codesOf(kind: Kind, alsoSent: readonly string[] = []): string[] {
  const shown = CASES.filter((c) => c.request.kind === kind && !c.name.startsWith('future-') && typeof c.response.body['code'] === 'string')
  return [...new Set([...shown.map((c) => c.response.body['code'] as string), ...alsoSent])].sort()
}
const REGISTER_CODES = codesOf('register')
const VERIFY_CODES = codesOf('verify', ['EMAIL_LIMIT_REACHED', 'EMAIL_EXHAUSTED'])
/** Codes a route answers only as a 5xx: the fallback names them SERVER_ERROR. */
const SERVER_ERROR_CODES = new Set(CASES.filter((c) => c.response.status >= 500).map((c) => c.response.body['code'] as string))

// ── the real pipeline: SDK call over a stubbed fetch → typed error → rendered text

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })

function makeCtx(respond: () => Response, extra: Partial<ToolContext> = {}): ToolContext {
  const fetchImpl = (async () => respond()) as typeof fetch
  return {
    get client(): AgentChatClient {
      throw new NotRegisteredError()
    },
    logger: pino({ level: 'silent' }),
    selfHandle: null,
    semaphore: new Semaphore(10),
    inflight: new Set(),
    rest: { apiBase: 'https://api.agentchat.test', apiKey: null, fetchImpl },
    turnKey: () => undefined,
    ...extra,
  } as unknown as ToolContext
}

const answerOf = (c: Case) => () => json(c.response.status, c.response.body, c.response.headers)

function joined(result: { content: unknown[] }): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n')
}

async function registerText(answer: () => Response, extra?: Partial<ToolContext>): Promise<string> {
  return joined(await registerAccount.createHandler(makeCtx(answer, extra))({ email: 'relay@example.com', handle: 'example-relay' }))
}

async function verifyText(answer: () => Response, extra?: Partial<ToolContext>): Promise<string> {
  return joined(await verifyOtp.createHandler(makeCtx(answer, extra))({ pending_id: 'pnd_example0pending01', code: '123456' }))
}

async function textOf(c: Case, extra?: Partial<ToolContext>): Promise<string> {
  const answer = answerOf(c)
  if (c.request.kind === 'register') {
    return joined(await registerAccount.createHandler(makeCtx(answer, extra))(c.request.body as registerAccount.Input))
  }
  return joined(await verifyOtp.createHandler(makeCtx(answer, extra))(c.request.body as verifyOtp.Input))
}

function nextLineOf(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('Next: '))
  expect(line, text).toBeDefined()
  return line!
}

/** What each client action looks like in the Next line of a tool on this surface. */
const ACTION_NEXT: Record<Exclude<Action, 'done' | 'legacy'>, RegExp> = {
  ask_code: /^Next: call agentchat_verify_otp with (pending_id `[^`]+`|the same pending_id) and the \d+-digit code\.$/,
  ask_param: /^Next: call agentchat_register again with a different `(email|handle)`\.$/,
  offer_new_code: /^Next: if the user wants a new code, (wait \d+ seconds, then )?call agentchat_register again with the same email and handle\.$/,
  wait_then_retry: /^Next: wait \d+ seconds, then call agentchat_(register|verify_otp) /,
  // A long wait names it; a server failure names the step to repeat; a step
  // this version does not know says to stop.
  stop: /^Next: ((wait \d+ seconds, then )?call agentchat_(register|verify_otp) |this tool does not know the step `[a-z_]+`; show the message above to the user and stop\.$)/,
}

describe('the contract’s sign-up cases', () => {
  it('are the contract version this code reads, with every action known and a text for every case', () => {
    expect(CONTRACT.version).toBe(1)
    expect(CONTRACT.wait_limit_s).toBe(60)
    expect(CONTRACT.start_steps).toEqual({ register: 'register', recover: 'recover', rotate_key: 'rotate_key' })
    expect(CONTRACT.verify_steps).toEqual({ register: 'verify', recover: 'recover_verify', rotate_key: 'rotate_key_verify' })
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length)
    for (const c of CASES) expect(CONTRACT.actions, c.name).toContain(c.expect.action)
    expect(Object.keys(TEXTS.tools).sort()).toEqual(TOOL_CASES.map((c) => c.name).sort())
    expect(Object.keys(TEXTS.rendered).sort()).toEqual(OTHER_CASES.map((c) => c.name).sort())
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s: the flow read from the answer is the contract’s', (_name, c) => {
    const flow = flowOf(c.response.body)
    if (c.expect.flow === null) {
      expect(flow).toBeNull()
      return
    }
    expect(flow).not.toBeNull()
    expect(pick(flow as unknown as Record<string, unknown>, READ_FIELDS)).toEqual(pick(c.expect.flow, READ_FIELDS))
    expect(pick(flow as unknown as Record<string, unknown>, DETAIL_FIELDS)).toEqual(pick(flowSource(c.response.body), DETAIL_FIELDS))
    expect(c.response.body['message']).toBe(c.expect.message)
  })

  it('when the texts change on purpose: SIGNUP_TEXTS_WRITE=1 rewrites them (then fails, to be reviewed)', async () => {
    if (process.env['SIGNUP_TEXTS_WRITE'] !== '1') return
    const tools: Record<string, string> = {}
    for (const c of TOOL_CASES) tools[c.name] = await textOf(c)
    const rendered: Record<string, string> = {}
    for (const c of OTHER_CASES) rendered[c.name] = renderFlow(c.response.body['message'] as string, flowOf(c.response.body)!)
    fs.writeFileSync(TEXTS_PATH, `${JSON.stringify({ about: TEXTS.about, tools, rendered }, null, 2)}\n`)
    throw new Error(`texts rewritten at ${TEXTS_PATH}; review the diff, then re-run without SIGNUP_TEXTS_WRITE`)
  })
})

describe('each server answer reaches the model as the server said it', () => {
  for (const c of TOOL_CASES) {
    it(`${c.name}: the exact text`, async () => {
      expect(await textOf(c)).toBe(TEXTS.tools[c.name])
    })
  }

  for (const c of TOOL_CASES.filter((tc) => tc.expect.flow !== null && tc.expect.action !== 'done')) {
    it(`${c.name}: the server’s code and message verbatim, a Next line for ${c.expect.action}, the facts present`, async () => {
      const shown = await textOf(c)
      if (c.expect.code !== null) {
        // The server's own code, whatever the HTTP status (a 5xx included).
        expect(shown.startsWith(`Error: ${c.expect.code}\n\n${c.expect.message}\nNext: `), shown).toBe(true)
      } else {
        expect(shown.startsWith(`${c.expect.message}\nNext: `), shown).toBe(true)
      }
      expect(nextLineOf(shown)).toMatch(ACTION_NEXT[c.expect.action as keyof typeof ACTION_NEXT])
      const flow = c.expect.flow!
      const details = flowSource(c.response.body)
      const retry = typeof flow['retry_after_s'] === 'number' ? flow['retry_after_s'] : 0
      if (retry > 0) expect(shown).toContain(`\n\nRetry after: ${retry} seconds.`)
      else expect(shown).not.toContain('Retry after:')
      if (details?.['limit'] !== undefined) expect(shown).toContain(`\nLimit: ${String(details['limit'])}.`)
      if (flow['param'] !== undefined) expect(shown).toContain(`\nInput to change: \`${String(flow['param'])}\`.`)
      // No rulebook of the tool's own: none of the fallback guidance shows.
      const guidance = c.request.kind === 'register' ? registerAccount.GUIDANCE : verifyOtp.GUIDANCE
      for (const text of Object.values(guidance)) expect(shown).not.toContain(text)
    })
  }

  it('register success adds the one agent line, naming the email the code went to', async () => {
    expect((await textOf(byName('register-code-sent'))).split('\n')).toEqual([
      'We sent a 6-digit code to relay@example.com. It expires in 10 minutes.',
      'Next: call agentchat_verify_otp with pending_id `pnd_example0pending01` and the 6-digit code.',
      "If you can't read relay@example.com yourself, ask the user for the code.",
    ])
  })

  it('the email caps after an accepted code (verify) read as they do at register', async () => {
    for (const name of ['register-email-limit-reached', 'register-email-exhausted']) {
      expect(await verifyText(answerOf(byName(name)))).toBe(TEXTS.tools[name])
    }
  })

  it.each(OTHER_CASES.map((c) => [c.name, c] as const))('%s: a step no tool here makes points to the manual', (_name, c) => {
    const flow = flowOf(c.response.body)!
    expect(renderFlow(c.expect.message, flow)).toBe(TEXTS.rendered[c.name])
    if (c.expect.action === 'done') expect(nextLine(flow)).toBe('Next: store the API key now; it is shown only once.')
    else expect(nextLine(flow)).toMatch(/no tool here does that, see “(Lost key — recovery|API key rotation)” at https:\/\/agentchat\.me\/skill\.md#(lost-key--recovery|api-key-rotation)\.$/)
  })
})

describe('the Next line names tools as the session’s runtime shows them', () => {
  const spell = (tool: string) => `mcp__agentchat__${tool}`

  it('through the context’s namer, in success and error answers', async () => {
    expect(nextLineOf(await textOf(byName('register-code-sent'), { nameTool: spell }))).toBe(
      'Next: call mcp__agentchat__agentchat_verify_otp with pending_id `pnd_example0pending01` and the 6-digit code.',
    )
    expect(nextLineOf(await textOf(byName('verify-wrong-code'), { nameTool: spell }))).toBe(
      'Next: call mcp__agentchat__agentchat_verify_otp with pending_id `pnd_example0pending01` and the 6-digit code.',
    )
    expect(nextLineOf(await textOf(byName('register-handle-taken'), { nameTool: spell }))).toBe(
      'Next: call mcp__agentchat__agentchat_register again with a different `handle`.',
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('buildMcpServer hands its toolNamer to the sign-up tools', async () => {
    vi.stubGlobal('fetch', (async () => answerOf(byName('register-cooldown'))()) as typeof fetch)
    const server = buildMcpServer({ apiBase: 'https://namer.agentchat.test', apiKey: null, toolNamer: (tool) => `agentchat__${tool}` })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'registration-codes', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      const result = await client.callTool({ name: 'agentchat_register', arguments: { email: 'relay@example.com', handle: 'example-relay' } })
      expect(result.isError).toBe(true)
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        'Error: OTP_COOLDOWN\n\nYou can request a new code in 42 seconds.\nNext: wait 42 seconds, then call agentchat__agentchat_register again.\n\nRetry after: 42 seconds.',
      )
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('rendering rules', () => {
  const base: SignupFlow = { next_step: 'register' }

  it('a step this code does not know says to stop; `done` says to store the key', () => {
    expect(nextLine({ next_step: 'confirm_device' })).toBe(
      'Next: this tool does not know the step `confirm_device`; show the message above to the user and stop.',
    )
    expect(nextLine({ next_step: 'done', status: 'approved' })).toBe('Next: store the API key now; it is shown only once.')
  })

  it('a wait comes first, also before an offer of a new code or a step no tool makes', () => {
    expect(nextLine({ ...base, status: 'max_attempts_reached', retry_after_s: 30 })).toBe(
      'Next: if the user wants a new code, wait 30 seconds, then call agentchat_register again with the same email and handle.',
    )
    expect(nextLine({ next_step: 'recover', retry_after_s: 12 })).toMatch(/^Next: wait 12 seconds, then recover the key; no tool here does that/)
    expect(nextLine({ ...base, retry_after_s: 0 })).toBe('Next: call agentchat_register again.')
  })

  it('the code length comes from the flow, 6 when absent; an unknown pending id is "the same pending_id"', () => {
    expect(nextLine({ next_step: 'verify', pending_id: 'pnd_9', code_length: 8 })).toBe(
      'Next: call agentchat_verify_otp with pending_id `pnd_9` and the 8-digit code.',
    )
    expect(nextLine({ next_step: 'verify' })).toBe('Next: call agentchat_verify_otp with the same pending_id and the 6-digit code.')
  })

  it('facts in a fixed order; the retry time is the boundary’s own line', () => {
    expect(factLines({ ...base, retry_after_s: 5, limit: 10, param: 'handle', handles: ['a-bot', 'b-bot'] })).toEqual([
      'Limit: 10.',
      'Input to change: `handle`.',
      'Handles: a-bot, b-bot.',
    ])
    expect(factLines(base)).toEqual([])
  })

  it('reads only well-typed fields and ignores the rest', () => {
    expect(
      flowOf({
        code: 'X',
        message: 'm',
        details: { next_step: 'register', status: 7, param: '', limit: 1.5, retry_after_s: -1, handles: ['ok', 3, ''], code_length: 0, brand_new_field: { a: 1 } },
      }),
    ).toEqual({ next_step: 'register', handles: ['ok'] })
    // A success body carries it at the top level; an error body only in details.
    expect(flowOf({ next_step: 'verify', pending_id: 'p' })).toEqual({ next_step: 'verify', pending_id: 'p' })
    expect(flowOf({ code: 'X', message: 'm', next_step: 'verify' })).toBeNull()
    expect(flowOf({ pending_id: 'p', message: 'sent' })).toBeNull()
    expect(flowOf(null)).toBeNull()
  })

  it('the retry time falls back to the Retry-After header when details carry none', async () => {
    const shown = await registerText(() =>
      json(429, { code: 'OTP_COOLDOWN', message: 'You can request a new code in 9 seconds.', details: { next_step: 'register' } }, { 'retry-after': '9' }),
    )
    expect(shown).toBe(
      'Error: OTP_COOLDOWN\n\nYou can request a new code in 9 seconds.\nNext: wait 9 seconds, then call agentchat_register again.\n\nRetry after: 9 seconds.',
    )
  })
})

describe('verify success: the key, and the server’s words when the SDK hands them over', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('with agentchatme 1.3.x (key and agent only): the answer as before, key and handle from the server', async () => {
    const payload = JSON.parse(await textOf(byName('verify-done'))) as Record<string, unknown>
    expect(payload['ok']).toBe(true)
    expect(payload['api_key']).toBe('ac_example-not-a-real-key')
    // The handle the server returned, not the typed one.
    expect(payload['handle']).toBe('example-relay')
    expect(payload['message']).toBeUndefined()
    expect(String(payload['important'])).toContain('exactly once')
  })

  it('with an SDK whose verify result carries the flow fields: the server’s message comes first', async () => {
    vi.spyOn(AgentChatClient, 'verify').mockResolvedValue({
      agent: { handle: 'example-relay' },
      apiKey: 'ac_example-not-a-real-key',
      client: {} as AgentChatClient,
      message: 'Email verified. Logged in as @example-relay.',
      next_step: 'done',
      status: 'approved',
    } as Awaited<ReturnType<typeof AgentChatClient.verify>>)
    const payload = JSON.parse(await verifyText(() => json(500, {}))) as Record<string, unknown>
    expect(Object.keys(payload).slice(0, 4)).toEqual(['ok', 'message', 'handle', 'api_key'])
    expect(payload['message']).toBe('Email verified. Logged in as @example-relay.')
  })
})

// ─── The fallback: a server that sends no next_step ────────────────────────

/**
 * Capitalized words in these texts that are not error codes. A new one has
 * to be added here (or to the contract's cases) on purpose.
 */
const NOT_CODES: ReadonlySet<string> = new Set([
  'API', // "API key"
  'POST', // the recovery request's HTTP method
  'HTTP',
  'MCP', // "MCP server", "MCP client"
  'AGENTCHAT_API_KEY', // the stdio server's environment variables
  'AGENTCHAT_API_BASE',
  'WITHOUT',
  'EXACTLY',
  'ONCE',
  'NOW',
  'NEWEST',
  'NOT',
])

const CAPITALIZED = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)*\b/g

function capitalizedWords(text: string): string[] {
  return [...new Set(text.match(CAPITALIZED) ?? [])]
}

async function inputSchemas(): Promise<Map<string, string>> {
  const server = buildMcpServer({ apiBase: 'https://codes.invalid', apiKey: null })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'registration-codes', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    const { tools } = await client.listTools()
    return new Map(tools.map((tool) => [tool.name, JSON.stringify(tool.inputSchema)]))
  } finally {
    await client.close()
    await server.close()
  }
}

const TOOLS = [
  { name: registerAccount.NAME, module: registerAccount, codes: REGISTER_CODES, text: registerText },
  { name: verifyOtp.NAME, module: verifyOtp, codes: VERIFY_CODES, text: verifyText },
] as const

describe('the sign-up tools name only codes the server sends', () => {
  function expectOnlyServerCodes(tool: (typeof TOOLS)[number], where: string, text: string) {
    for (const word of capitalizedWords(text)) {
      if (NOT_CODES.has(word)) continue
      expect(tool.codes, `${tool.name} ${where} names ${word}`).toContain(word)
    }
  }

  it('every capitalized word in each description, parameter text and fallback guidance is a server code of that route, or a known non-code', async () => {
    const schemas = await inputSchemas()
    for (const tool of TOOLS) {
      expectOnlyServerCodes(tool, 'description', tool.module.DESCRIPTION)
      expectOnlyServerCodes(tool, 'parameters', schemas.get(tool.name)!)
      for (const [code, text] of Object.entries(tool.module.GUIDANCE)) expectOnlyServerCodes(tool, `guidance for ${code}`, text)
    }
  })

  it('the descriptions defer to the server’s Next line, and keep only what the agent alone can know', () => {
    for (const tool of TOOLS) expect(tool.module.DESCRIPTION).toContain('the server’s message and a `Next:` line naming the call to make; follow it.')
    expect(registerAccount.DESCRIPTION).toContain(
      'if HANDLE_TAKEN names the handle you just registered after an agentchat_verify_otp that got no answer or no key, that account is yours — keep the handle and recover its key',
    )
    expect(verifyOtp.DESCRIPTION).toContain('the account may exist: recover its key with the handle and email, and do not register another handle')
  })
})

describe('an older server (no next_step): the per-code fallback', () => {
  it('the fallback guidance is keyed only by codes the route sends, and covers every one the model sees under its own code', () => {
    for (const tool of TOOLS) {
      for (const code of Object.keys(tool.module.GUIDANCE)) expect(tool.codes, `${tool.name} guides ${code}`).toContain(code)
      for (const code of tool.codes) {
        // A 5xx reaches the model as SERVER_ERROR ("transient; retry
        // shortly"), whatever the wire code: guidance keyed by it would
        // never be read.
        if (SERVER_ERROR_CODES.has(code)) {
          expect(tool.module.GUIDANCE[code], `${tool.name}: ${code} is a 5xx`).toBeUndefined()
          continue
        }
        expect(tool.module.GUIDANCE[code], `${tool.name} has fallback guidance for ${code}`).toBeTruthy()
      }
    }
  })

  it('the contract’s legacy cases get the fallback: the server’s words, the guidance, no Next line', async () => {
    const legacy = TOOL_CASES.filter((c) => c.expect.action === 'legacy')
    expect(legacy.length).toBeGreaterThan(0)
    for (const c of legacy) {
      const shown = await textOf(c)
      expect(shown, c.name).not.toContain('Next: ')
      expect(shown, c.name).toContain(c.expect.message)
      if (c.expect.code !== null) {
        const guidance = (c.request.kind === 'register' ? registerAccount.GUIDANCE : verifyOtp.GUIDANCE)[c.expect.code]!
        expect(shown, c.name).toContain(guidance)
      }
    }
  })

  for (const tool of TOOLS) {
    for (const [code, guidance] of Object.entries(tool.module.GUIDANCE)) {
      it(`${tool.name}: ${code} without a flow object gets the server's message and the fallback guidance`, async () => {
        const status = /^(OTP_COOLDOWN|OTP_HOURLY_CAP|OTP_EMAIL_LOCKED|OTP_ATTEMPTS_EXHAUSTED|RATE_LIMITED)$/.test(code)
          ? 429
          : /^(HANDLE_TAKEN|EMAIL_LIMIT_REACHED|EMAIL_EXHAUSTED)$/.test(code)
            ? 409
            : 400
        const retry: Record<string, string> =
          code === 'RATE_LIMITED' || code === 'OTP_ATTEMPTS_EXHAUSTED' ? {} : status === 429 ? { 'retry-after': '42' } : {}
        // An older server's body: code and message, details without next_step.
        const shown = await tool.text(() => json(status, { code, message: `Old server says ${code}.`, details: { limit: 10 } }, retry))
        expect(shown.startsWith(`Error: ${code}\n\n`), shown).toBe(true)
        if (code === 'RATE_LIMITED') expect(shown).toMatch(/^Rate limit exceeded\. Old server says RATE_LIMITED\. /m)
        else expect(shown).toContain(`Old server says ${code}. `)
        expect(shown).toContain(guidance)
        expect(shown).not.toContain('Next: ')
        if ('retry-after' in retry) expect(shown).toContain('Retry after: 42 seconds.')
        else expect(shown).not.toContain('Retry after:')
      })
    }

    it(`${tool.name}: a 5xx without a flow object is SERVER_ERROR, as before`, async () => {
      const shown = await tool.text(() => json(500, { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }))
      expect(shown).toBe('Error: SERVER_ERROR\n\nAgentChat reported a server-side error. This is transient; retry shortly.')
    })
  }
})

describe('an earlier verify that may have created the account', () => {
  it('a 2xx without a key gives the recovery step, and never says to verify again', async () => {
    const noKey = await verifyText(() => json(201, { agent: { handle: 'example-relay' } }))
    expect(noKey).toContain(RECOVER_THE_KEY)
    expect(noKey).not.toMatch(/retry agentchat_verify_otp/i)
    // The server said success: the account exists, under a handle the agent keeps.
    expect(noKey).toContain('the account exists with a key you do not hold')
    expect(noKey).toContain('Do not register another handle.')
    for (const word of capitalizedWords(noKey)) {
      if (NOT_CODES.has(word) || word === 'INTERNAL_ERROR') continue
      expect(VERIFY_CODES, `no-key text names ${word}`).toContain(word)
    }
  })

  it('the recovery step says where it runs, and never reads a missing code as a missing account', () => {
    // No tool in this package recovers a key (by decision): the step names the
    // agentchat CLI, the two public endpoints, and the operator for a host
    // that can do neither.
    expect(RECOVER_THE_KEY).toMatch(/^Recover its key with the handle and email; no tool here does that\./)
    expect(RECOVER_THE_KEY).toContain('`agentchat recover --handle <handle> --email <email>`, then `agentchat recover --code <code>`')
    expect(RECOVER_THE_KEY).toContain('POST /v1/agents/recover {"email","handle"}, then POST /v1/agents/recover/verify {"pending_id","code"}, on https://api.agentchat.me (or AGENTCHAT_API_BASE when set)')
    expect(RECOVER_THE_KEY).toContain('If you can do neither, ask your operator.')
    expect(RECOVER_THE_KEY).toContain('No code is sent within a minute of another code to the same email (a sign-up code counts): wait a minute and ask once more.')
    expect(RECOVER_THE_KEY).toContain('A missing code never means the account is missing; if none comes, ask your operator.')
    expect(RECOVER_THE_KEY).not.toMatch(/no account was created|register again/i)
  })
})
