import { createHash } from 'node:crypto'
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
import { actionOf as actionOfFlow, factLines, flowOf, nextLine, nextStep, renderFlow, type SignupFlow } from '../../src/tools/_signup.js'
import { RECOVER_THE_KEY } from '../../src/tools/_texts.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Sign-up answers: the server says the next step ────────────────────────
//
// An agent with no integration onboards through exactly these two tools, so
// what they say about an answer is the advice it gets at its first step. A
// current server's answer carries a flow object (contract v1, "Sign-up
// flows"): `next_step`, the facts, and a message safe to show verbatim. The
// tools render it and add no rulebook of their own. An error: the server's
// code and message, one `Next:` line naming the tool for `next_step`, the
// facts present. A success keeps the JSON it always had: the server's
// fields (new facts as new keys), `next_step` the human-readable
// instruction built from the server's step.
//
// The cases are the contract's sign-up conformance cases
// (tests/fixtures/contract/signup-flow.cases.json, a byte-identical copy of
// https://agentchat.me/contract/v1/conformance/signup-flow.cases.json, held
// to the contract manifest's sha256 beside it): each
// request, the server's answer, and the flow, message and client action a
// client derives. tests/fixtures/signup-flow.texts.json holds the exact text
// the model reads for each. When the contract changes, copy its cases
// again; these tests then say which text changed (regenerate the texts with
// SIGNUP_TEXTS_WRITE=1 and review the diff).
//
// The per-code guidance the tools carried before is kept only for a server
// that sends no `next_step` (an older server); the contract's `legacy` cases
// and the last part of this file hold that fallback.
//
// Connector sign-in (`finish: "connector"`: the right code signs a runtime in
// and no key is given, `next_step` connect) is not this surface's: no tool
// here starts one, since agentchat_register takes no `finish`. Its cases are
// set apart (CONNECTOR_CASES), and a guard fails once a tool here can start
// one, so that its answers are then handled and held to these cases too.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

type Kind = 'register' | 'verify' | 'recover' | 'recover_verify' | 'rotate_key' | 'rotate_key_verify'
type Action = 'done' | 'ask_code' | 'ask_param' | 'offer_new_code' | 'wait_then_retry' | 'stop' | 'legacy' | 'connect'

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

const CASES_PATH = path.join(FIXTURES, 'contract', 'signup-flow.cases.json')
const CONTRACT = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as Cases
const TEXTS_PATH = path.join(FIXTURES, 'signup-flow.texts.json')
const TEXTS = JSON.parse(fs.readFileSync(TEXTS_PATH, 'utf8')) as Texts
const ALL_CASES = CONTRACT.cases
/** A connector sign-in case: a start with `finish`, or the `connect` answer to its code. */
const isConnector = (c: Case) => 'finish' in c.request.body || c.expect.action === 'connect'
const CONNECTOR_CASES = ALL_CASES.filter(isConnector)
/** The cases of this surface: every one but connector sign-in's. */
const CASES = ALL_CASES.filter((c) => !isConnector(c))
const onTool = (c: Case) => c.request.kind === 'register' || c.request.kind === 'verify'
const TOOL_CASES = CASES.filter(onTool)
const OTHER_CASES = CASES.filter((c) => !onTool(c))
const byName = (name: string): Case => {
  const found = ALL_CASES.find((c) => c.name === name)
  if (found === undefined) throw new Error(`no contract case ${name}`)
  return found
}

const STEP_OF_KIND: Record<Kind, string> = {
  register: 'register',
  verify: 'verify',
  recover: 'recover',
  recover_verify: 'recover_verify',
  rotate_key: 'rotate_key',
  rotate_key_verify: 'rotate_key_verify',
}

/** The contract's client action for a case, by the tools' own rule (`actionOf`), from the step that was called. */
function actionOf(c: Case): Action {
  const flow = flowOf(c.response.body)
  return flow === null ? 'legacy' : actionOfFlow(flow, c.response.status, STEP_OF_KIND[c.request.kind])
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
 * request kind (a `future-` case is a code no server sends yet).
 */
function codesOf(kind: Kind): string[] {
  const shown = CASES.filter((c) => c.request.kind === kind && !c.name.startsWith('future-') && typeof c.response.body['code'] === 'string')
  return [...new Set(shown.map((c) => c.response.body['code'] as string))].sort()
}
const REGISTER_CODES = codesOf('register')
const VERIFY_CODES = codesOf('verify')
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

/** The Next line of an error's text, or of a register success: "Next: " + its JSON `next_step`. */
/** An answer of a call no tool here makes, rendered as a tool here renders one. */
function renderAlone(c: Case): string {
  return renderFlow(c.expect.message, flowOf(c.response.body)!, { calledStep: STEP_OF_KIND[c.request.kind], httpStatus: c.response.status })
}

/**
 * A tool's text with what depends on the installed SDK taken out: verify
 * success carries the server's `message` only when the SDK's verify result
 * hands it over (agentchatme 1.3.x does not). Present, it must be the
 * server's, right after `ok`.
 */
function sdkNeutral(text: string, serverMessage: string): string {
  if (!text.startsWith('{')) return text
  const payload = JSON.parse(text) as Record<string, unknown>
  if (!('api_key' in payload) || !('message' in payload)) return text
  expect(payload['message']).toBe(serverMessage)
  expect(Object.keys(payload).slice(0, 2)).toEqual(['ok', 'message'])
  const { message: _message, ...rest } = payload
  return JSON.stringify(rest, null, 2)
}

function nextLineOf(text: string): string {
  if (text.startsWith('{')) {
    const payload = JSON.parse(text) as Record<string, unknown>
    return `Next: ${String(payload['next_step'])}`
  }
  const line = text.split('\n').find((l) => l.startsWith('Next: '))
  expect(line, text).toBeDefined()
  return line!
}

/** A register success's `next_step` ends with the one line only the tool adds. */
const AGENT_LINE = " If you can't read relay@example.com yourself, ask the user for the code."

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** What each client action looks like in the Next line of a tool on this surface. */
const ACTION_NEXT: Record<Exclude<Action, 'done' | 'legacy' | 'connect'>, RegExp> = {
  ask_code: /^Next: [Cc]all agentchat_verify_otp with (pending_id `[^`]+`|the same pending_id) and the \d+-digit code\.( If you can't read \S+ yourself, ask the user for the code\.)?$/,
  ask_param: /^Next: call agentchat_register again with a different `(email|handle)`\.$/,
  offer_new_code: /^Next: if the user wants a new code, (wait \d+ seconds, then )?call agentchat_register again with the same email and handle\.$/,
  wait_then_retry: /^Next: wait \d+ seconds, then call agentchat_(register again\.|verify_otp with .+-digit code\.)$/,
  // Says to stop, and after a long wait when the step can be taken again; a
  // step this version does not know says to stop. A 5xx has no Next line.
  stop: /^Next: (show the message to the user and stop(; after \d+ seconds, .+)?\.|this tool does not know the step `[a-z_]+`; show the message to the user and stop\.)$/,
}

describe('the contract’s sign-up cases', () => {
  it('are a byte-identical copy of the contract’s, by the sha256 its manifest lists', () => {
    const [line] = fs.readFileSync(path.join(FIXTURES, 'contract', 'signup-flow.cases.json.sha256'), 'utf8').trim().split('\n')
    const [digest, name] = line!.split(/\s+/)
    expect(name).toBe('signup-flow.cases.json')
    expect(createHash('sha256').update(fs.readFileSync(CASES_PATH)).digest('hex')).toBe(digest)
  })

  it('state the action the tools’ rule gives, for the step that was called', () => {
    expect(CONTRACT.wait_limit_s).toBe(60)
    expect(new Set(Object.values(CONTRACT.verify_steps))).toEqual(new Set(['verify', 'recover_verify', 'rotate_key_verify']))
    expect(new Set(Object.values(CONTRACT.start_steps))).toEqual(new Set(['register', 'recover', 'rotate_key']))
    for (const c of CASES) expect(actionOf(c), c.name).toBe(c.expect.action)
  })

  it('are the contract version this code reads, with every action known and a text for every case', () => {
    expect(CONTRACT.version).toBe(1)
    expect(CONTRACT.wait_limit_s).toBe(60)
    expect(CONTRACT.start_steps).toEqual({ register: 'register', recover: 'recover', rotate_key: 'rotate_key' })
    expect(CONTRACT.verify_steps).toEqual({ register: 'verify', recover: 'recover_verify', rotate_key: 'rotate_key_verify' })
    expect(new Set(ALL_CASES.map((c) => c.name)).size).toBe(ALL_CASES.length)
    for (const c of ALL_CASES) expect(CONTRACT.actions, c.name).toContain(c.expect.action)
    expect(Object.keys(TEXTS.tools).sort()).toEqual(TOOL_CASES.map((c) => c.name).sort())
    expect(Object.keys(TEXTS.rendered).sort()).toEqual(OTHER_CASES.map((c) => c.name).sort())
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: the flow read from the answer is the contract’s', (_name, c) => {
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

  it('connector sign-in is not this surface’s: no tool here takes `finish`, and its cases are the ones set apart', () => {
    // Set apart: every start with `finish` and every `connect` answer, in
    // each flow that offers it.
    expect(CONNECTOR_CASES.map((c) => c.request.kind).sort()).toEqual(['recover', 'recover_verify', 'register', 'verify'])
    expect(CONTRACT.actions).toContain('connect')
    for (const c of CASES) expect(c.expect.action, c.name).not.toBe('connect')
    // Once agentchat_register can start a connector sign-up, its `connect`
    // answer reaches agentchat_verify_otp: handle it, and drop this split.
    expect(Object.keys(registerAccount.INPUT_SHAPE)).not.toContain('finish')
  })

  it('when the texts change on purpose: SIGNUP_TEXTS_WRITE=1 rewrites them (then fails, to be reviewed)', async () => {
    if (process.env['SIGNUP_TEXTS_WRITE'] !== '1') return
    const tools: Record<string, string> = {}
    for (const c of TOOL_CASES) tools[c.name] = await textOf(c)
    const rendered: Record<string, string> = {}
    for (const c of OTHER_CASES) rendered[c.name] = renderAlone(c)
    fs.writeFileSync(TEXTS_PATH, `${JSON.stringify({ about: TEXTS.about, tools, rendered }, null, 2)}\n`)
    throw new Error(`texts rewritten at ${TEXTS_PATH}; review the diff, then re-run without SIGNUP_TEXTS_WRITE`)
  })
})

describe('each server answer reaches the model as the server said it', () => {
  for (const c of TOOL_CASES) {
    it(`${c.name}: the exact text`, async () => {
      expect(sdkNeutral(await textOf(c), c.expect.message)).toBe(sdkNeutral(TEXTS.tools[c.name]!, c.expect.message))
    })
  }

  for (const c of TOOL_CASES.filter((tc) => tc.expect.flow !== null && tc.expect.code !== null && tc.response.status >= 500)) {
    it(`${c.name}: a server failure shows the server’s code and words, and no Next line`, async () => {
      const shown = await textOf(c)
      expect(shown, shown).toBe(`Error: ${c.expect.code}\n\n${c.expect.message}`)
    })
  }

  for (const c of TOOL_CASES.filter((tc) => tc.expect.flow !== null && tc.expect.code !== null && tc.response.status < 500)) {
    it(`${c.name}: the server’s code and message verbatim, a Next line for ${actionOf(c)}, the facts present`, async () => {
      const shown = await textOf(c)
      // The server's own code.
      expect(shown.startsWith(`Error: ${c.expect.code}\n\n${c.expect.message}\nNext: `), shown).toBe(true)
      expect(nextLineOf(shown)).toMatch(ACTION_NEXT[actionOf(c) as keyof typeof ACTION_NEXT])
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

  // The keys an older server's success gave (tests/fixtures/tool-outputs.json): every one stays.
  const LEGACY_REGISTER_KEYS = ['ok', 'pending_id', 'message', 'next_step']

  for (const c of TOOL_CASES.filter((tc) => tc.request.kind === 'register' && tc.expect.code === null)) {
    it(`${c.name}: the same JSON as before — the server’s fields, next_step the instruction built from its step`, async () => {
      const payload = JSON.parse(await textOf(c)) as Record<string, unknown>
      expect(Object.keys(payload).slice(0, 2)).toEqual(['ok', 'pending_id'])
      for (const key of LEGACY_REGISTER_KEYS) expect(payload, key).toHaveProperty(key)
      expect(payload['ok']).toBe(true)
      expect(payload['message']).toBe(c.expect.message)
      const body = c.response.body
      if (c.expect.flow === null) {
        // An older server: the instruction as before.
        expect(String(payload['next_step'])).toMatch(/^A 6-digit verification code was emailed to relay@example\.com\. Call agentchat_verify_otp with this pending_id/)
        return
      }
      // Every field the server sent is there as it came (new facts as new
      // keys), except next_step, which is the instruction.
      for (const [key, value] of Object.entries(body)) if (key !== 'next_step') expect(payload[key], key).toEqual(value)
      expect(payload['next_step']).toBe(`${capitalized(nextStep(flowOf(body)!, { calledStep: 'register', httpStatus: 200 })!)}${AGENT_LINE}`)
      expect(nextLineOf(JSON.stringify(payload))).toMatch(ACTION_NEXT[actionOf(c) as keyof typeof ACTION_NEXT])
    })
  }

  it('register success adds the one agent line, naming the email the code went to', async () => {
    const payload = JSON.parse(await textOf(byName('register-code-sent'))) as Record<string, unknown>
    expect(payload['next_step']).toBe(
      "Call agentchat_verify_otp with pending_id `pnd_example0pending01` and the 6-digit code. If you can't read relay@example.com yourself, ask the user for the code.",
    )
  })

  it('the email caps after an accepted code (verify) read as they do at register', () => {
    expect(TEXTS.tools['verify-email-limit-reached-race']).toBe(TEXTS.tools['register-email-limit-reached'])
    expect(TEXTS.tools['verify-email-exhausted-race']).toBe(TEXTS.tools['register-email-exhausted'])
  })

  it('a wait that outlasts the code offers a new code, never points back to the code that will be gone', () => {
    // OTP_EMAIL_LOCKED always answers the start step; another verify-route
    // 429 keeps the verify step only while the code outlives the wait. A
    // start step after a code step is a new code: only offered.
    expect(nextLineOf(TEXTS.tools['verify-email-locked']!)).toBe(
      'Next: show the message to the user and stop; after 840 seconds, if the user wants a new code, call agentchat_register again with the same email and handle.',
    )
    expect(nextLineOf(TEXTS.tools['verify-rate-limited-past-the-code']!)).toBe(
      'Next: if the user wants a new code, wait 35 seconds, then call agentchat_register again with the same email and handle.',
    )
    expect(nextLineOf(TEXTS.tools['verify-rate-limited']!)).toBe(
      'Next: wait 35 seconds, then call agentchat_verify_otp with the same pending_id and the 6-digit code.',
    )
  })

  it.each(OTHER_CASES.map((c) => [c.name, c] as const))('%s: a step no tool here makes points to the manual', (_name, c) => {
    const flow = flowOf(c.response.body)!
    expect(renderAlone(c)).toBe(TEXTS.rendered[c.name])
    const line = nextLine(flow, { calledStep: STEP_OF_KIND[c.request.kind], httpStatus: c.response.status })
    if (c.expect.action === 'done') expect(line).toBe('Next: store the API key now; it is shown only once.')
    else expect(line).toMatch(/no tool here does that, see “(Lost key — recovery|API key rotation)” at https:\/\/agentchat\.me\/skill\.md#(lost-key--recovery|api-key-rotation)\.$/)
  })
})

describe('the Next line names tools as the session’s runtime shows them', () => {
  const spell = (tool: string) => `mcp__agentchat__${tool}`

  it('through the context’s namer, in success and error answers', async () => {
    expect(nextLineOf(await textOf(byName('register-code-sent'), { nameTool: spell }))).toBe(
      `Next: Call mcp__agentchat__agentchat_verify_otp with pending_id \`pnd_example0pending01\` and the 6-digit code.${AGENT_LINE}`,
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
      'Next: this tool does not know the step `confirm_device`; show the message to the user and stop.',
    )
    expect(nextLine({ next_step: 'done', status: 'approved' })).toBe('Next: store the API key now; it is shown only once.')
  })

  it('a wait comes first, also before an offer of a new code or a step no tool makes', () => {
    expect(nextLine({ ...base, status: 'max_attempts_reached', retry_after_s: 30 })).toBe(
      'Next: if the user wants a new code, wait 30 seconds, then call agentchat_register again with the same email and handle.',
    )
    // Without a retry time, the time until a new code may be requested.
    expect(nextLine({ ...base, status: 'max_attempts_reached', resend_after_s: 25 })).toBe(
      'Next: if the user wants a new code, wait 25 seconds, then call agentchat_register again with the same email and handle.',
    )
    expect(nextLine({ ...base, status: 'expired', resend_after_s: 0 })).toBe(
      'Next: if the user wants a new code, call agentchat_register again with the same email and handle.',
    )
    expect(nextLine({ next_step: 'recover', retry_after_s: 12 })).toMatch(/^Next: wait 12 seconds, then recover the key; no tool here does that/)
    expect(nextLine({ ...base, retry_after_s: 0 }, { calledStep: 'register', httpStatus: 429 })).toBe('Next: call agentchat_register again.')
  })

  it('a start step after a code step refused for now (429) is a new code, only offered; to the start step, a retry', () => {
    const wait: SignupFlow = { next_step: 'register', retry_after_s: 35 }
    expect(nextLine(wait, { calledStep: 'verify', httpStatus: 429 })).toBe(
      'Next: if the user wants a new code, wait 35 seconds, then call agentchat_register again with the same email and handle.',
    )
    expect(nextLine(wait, { calledStep: 'register', httpStatus: 429 })).toBe('Next: wait 35 seconds, then call agentchat_register again.')
    expect(nextLine({ next_step: 'register' }, { calledStep: 'verify', httpStatus: 429 })).toBe(
      'Next: if the user wants a new code, call agentchat_register again with the same email and handle.',
    )
    // An input to change is asked for whatever was called.
    expect(nextLine({ next_step: 'register', param: 'email' }, { calledStep: 'verify', httpStatus: 409 })).toBe(
      'Next: call agentchat_register again with a different `email`.',
    )
  })

  it('any other refusal of a code step stops: no new code, no second registration', () => {
    // A malformed request, or the account gone after the code: stop.
    expect(actionOfFlow({ next_step: 'register' }, 400, 'verify')).toBe('stop')
    expect(actionOfFlow({ next_step: 'recover' }, 404, 'recover_verify')).toBe('stop')
    expect(nextLine({ next_step: 'register' }, { calledStep: 'verify', httpStatus: 400 })).toBe('Next: show the message to the user and stop.')
    // A code that ended is still a new code, whatever the status.
    expect(nextLine({ next_step: 'register', status: 'expired' }, { calledStep: 'verify', httpStatus: 400 })).toBe(
      'Next: if the user wants a new code, call agentchat_register again with the same email and handle.',
    )
  })

  it('a wait longer than a client sits out stops, and says when the step can be taken again', () => {
    expect(nextLine({ next_step: 'register', retry_after_s: 1800 }, { calledStep: 'register', httpStatus: 429 })).toBe(
      'Next: show the message to the user and stop; after 1800 seconds, call agentchat_register again.',
    )
    expect(nextLine({ next_step: 'register', retry_after_s: 840 }, { calledStep: 'verify', httpStatus: 429 })).toBe(
      'Next: show the message to the user and stop; after 840 seconds, if the user wants a new code, call agentchat_register again with the same email and handle.',
    )
    expect(nextLine({ next_step: 'verify', retry_after_s: 120, pending_id: 'pnd_9' }, { calledStep: 'verify', httpStatus: 429 })).toBe(
      'Next: show the message to the user and stop; after 120 seconds, call agentchat_verify_otp with pending_id `pnd_9` and the 6-digit code.',
    )
  })

  it('a server failure renders the server’s words and no Next line', () => {
    expect(actionOfFlow({ next_step: 'register' }, 500, 'verify')).toBe('stop')
    expect(nextLine({ next_step: 'register' }, { calledStep: 'verify', httpStatus: 500 })).toBeNull()
    expect(renderFlow('We couldn’t send the code. Try again in a few minutes.', { next_step: 'register' }, { httpStatus: 500 })).toBe(
      'We couldn’t send the code. Try again in a few minutes.',
    )
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

  it('with the installed SDK: key and handle from the server, and its message first when the SDK hands it over', async () => {
    const done = byName('verify-done')
    const payload = JSON.parse(await textOf(done)) as Record<string, unknown>
    expect(payload['ok']).toBe(true)
    expect(payload['api_key']).toBe('ac_example-not-a-real-key')
    // The handle the server returned, not the typed one.
    expect(payload['handle']).toBe('example-relay')
    // agentchatme 1.3.x returns only the key and the agent; a later SDK
    // returns the flow fields too.
    if (payload['message'] !== undefined) expect(Object.keys(payload).slice(0, 2)).toEqual(['ok', 'message'])
    expect([undefined, done.expect.message]).toContain(payload['message'])
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

describe('verify success: the server’s reachability as it came, and `then` pointing at it', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const done = byName('verify-done')
  const REACHABILITY = done.response.body['reachability'] as Record<string, unknown>
  /** The stdio composition's save, succeeding. */
  const saved = () => ({ saved: true as const, path: '/home/relay/.agentchat/credentials', alreadyThere: false, conflict: null })
  /** A verify result as an SDK hands it over, with `extra` on top. */
  const minted = (extra: Record<string, unknown>) =>
    ({
      agent: { handle: 'example-relay' },
      apiKey: 'ac_example-not-a-real-key',
      client: {} as AgentChatClient,
      message: 'Email verified. Logged in as @example-relay.',
      next_step: 'done',
      status: 'approved',
      ...extra,
    }) as Awaited<ReturnType<typeof AgentChatClient.verify>>

  it('the contract’s verify-done carries a new account’s reachability: state none, the ways in its text', () => {
    expect(REACHABILITY).toMatchObject({ version: 1, state: 'none', via: null, problem: null })
    expect(typeof REACHABILITY['text']).toBe('string')
    // The server's message points at it; `then` adds the identity line.
    expect(done.expect.message).toContain('reachability.text')
  })

  it('hosted: the server’s reachability unchanged, right before `then`, which points at it', async () => {
    const payload = JSON.parse(await textOf(done)) as Record<string, unknown>
    expect(payload['reachability']).toEqual(REACHABILITY)
    expect(Object.keys(payload).slice(-2)).toEqual(['reachability', 'then'])
    expect(payload['then']).toBe(verifyOtp.THEN)
    expect(payload['api_key']).toBe('ac_example-not-a-real-key')
  })

  it('stdio, the key saved: the same reachability and `then`', async () => {
    const payload = JSON.parse(await textOf(done, { saveKey: saved })) as Record<string, unknown>
    expect(payload['key_saved_in']).toBe('/home/relay/.agentchat/credentials')
    expect(payload['api_key']).toBeUndefined()
    expect(payload['reachability']).toEqual(REACHABILITY)
    expect(Object.keys(payload).slice(-2)).toEqual(['reachability', 'then'])
    expect(payload['then']).toBe(verifyOtp.THEN)
  })

  it('stdio, the key not saved: handed back with the same reachability and `then`', async () => {
    const notSaved = () => ({ saved: false as const, path: '', reason: 'the home already holds another agent’s key (@other)' })
    const payload = JSON.parse(await textOf(done, { saveKey: notSaved })) as Record<string, unknown>
    expect(payload['api_key']).toBe('ac_example-not-a-real-key')
    expect(String(payload['not_saved'])).toContain('another agent’s key')
    expect(payload['reachability']).toEqual(REACHABILITY)
    expect(payload['then']).toBe(verifyOtp.THEN)
  })

  it('a state and fields this code does not know pass through as they came', async () => {
    const later = { ...REACHABILITY, state: 'added_later', wake_hint: { kind: 'new' } }
    vi.spyOn(AgentChatClient, 'verify').mockResolvedValue(minted({ reachability: later }))
    const hosted = JSON.parse(await verifyText(() => json(500, {}))) as Record<string, unknown>
    expect(hosted['reachability']).toEqual(later)
    expect(hosted['then']).toBe(verifyOtp.THEN)
    const stdio = JSON.parse(await verifyText(() => json(500, {}), { saveKey: saved })) as Record<string, unknown>
    expect(stdio['reachability']).toEqual(later)
  })

  it('without reachability (a server that predates it): no such key, and `then` is the identity line alone', async () => {
    vi.spyOn(AgentChatClient, 'verify').mockResolvedValue(minted({}))
    for (const extra of [{}, { saveKey: saved }] as Array<Partial<ToolContext>>) {
      const payload = JSON.parse(await verifyText(() => json(500, {}), extra)) as Record<string, unknown>
      expect(payload).not.toHaveProperty('reachability')
      expect(payload['then']).toBe(verifyOtp.ANCHOR_LINE)
    }
  })

  it('`then` keeps the identity line and adds one plain instruction: no condition, no link, no wake words of its own', () => {
    expect(verifyOtp.THEN.startsWith(`${verifyOtp.ANCHOR_LINE} `)).toBe(true)
    const wake = verifyOtp.THEN.slice(verifyOtp.ANCHOR_LINE.length + 1)
    expect(wake).toBe('Then do what reachability.text in this answer says now, before you stop (agentchat_get_my_status shows it too).')
    expect(wake).not.toMatch(/\b(if|unless|webhook|wake link|wake check|integration)\b/i)
    expect(verifyOtp.THEN).not.toMatch(/https?:\/\//)
    expect(verifyOtp.thenOf(undefined)).toBe(verifyOtp.ANCHOR_LINE)
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
    expect(registerAccount.DESCRIPTION).toContain('Every answer gives the server’s message and, unless the server failed, the call to make next (an error’s `Next:` line, a success’s `next_step`); follow it.')
    expect(verifyOtp.DESCRIPTION).toContain('Every error gives the server’s message and, unless the server failed, the call to make next (its `Next:` line); follow it.')
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
