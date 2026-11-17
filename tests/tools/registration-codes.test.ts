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
// The cases are tests/fixtures/signup-flow.cases.json: every situation of
// the contract's sign-up code table as the server answers it, with the flow
// a client reads, the client action it leads to, and the exact text the
// model reads. When the contract changes, change the fixture first; these
// tests then say which text to change.
//
// The per-code guidance the tools carried before is kept only for a server
// that sends no `next_step` (an older server); the last part of this file
// holds that fallback.

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'signup-flow.cases.json')

type Request = 'register' | 'verify' | 'recover' | 'recover_verify' | 'rotate_key' | 'rotate_key_verify'
type Action = 'done' | 'ask_code' | 'ask_param' | 'offer_new_code' | 'wait_then_retry' | 'stop'

interface Case {
  name: string
  request: Request
  status: number
  headers: Record<string, string>
  body: Record<string, unknown>
  expected: { flow: Record<string, unknown>; action: Action; text: string | null }
}

const CASES = (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: Case[] }).cases
const TOOL_CASES = CASES.filter((c) => c.request === 'register' || c.request === 'verify')
const OTHER_CASES = CASES.filter((c) => c.request !== 'register' && c.request !== 'verify')

/** The flow fields these tools read; every other field is ignored. */
const READ_FIELDS = ['next_step', 'status', 'pending_id', 'param', 'code_length', 'retry_after_s', 'limit', 'handles'] as const

function readPart(flow: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(READ_FIELDS.filter((f) => flow[f] !== undefined).map((f) => [f, flow[f]]))
}

/** The codes each tool's route answers with, from the cases. */
function codesOf(request: Request): string[] {
  return [...new Set(CASES.filter((c) => c.request === request && typeof c.body['code'] === 'string').map((c) => c.body['code'] as string))]
}
const REGISTER_CODES = codesOf('register')
const VERIFY_CODES = codesOf('verify')

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

const answerOf = (c: Case) => () => json(c.status, c.body, c.headers)

async function registerText(answer: () => Response, extra?: Partial<ToolContext>): Promise<string> {
  const result = await registerAccount.createHandler(makeCtx(answer, extra))({ email: 'owner@example.com', handle: 'fresh-bot' })
  return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n')
}

async function verifyText(answer: () => Response, extra?: Partial<ToolContext>): Promise<string> {
  const result = await verifyOtp.createHandler(makeCtx(answer, extra))({ pending_id: 'pnd_1', code: '123456' })
  return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n')
}

const textOf = (c: Case, extra?: Partial<ToolContext>) =>
  c.request === 'register' ? registerText(answerOf(c), extra) : verifyText(answerOf(c), extra)

function nextLineOf(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('Next: '))
  expect(line, text).toBeDefined()
  return line!
}

/** What each client action looks like in the Next line of a tool on this surface. */
const ACTION_NEXT: Record<Exclude<Action, 'done'>, RegExp> = {
  ask_code: /^Next: (wait \d+ seconds, then )?call agentchat_verify_otp with (pending_id `[^`]+`|the same pending_id) and the \d+-digit code\.$/,
  ask_param: /^Next: call agentchat_register again with a different `(email|handle)`\.$/,
  offer_new_code: /^Next: if the user wants a new code, (wait \d+ seconds, then )?call agentchat_register again with the same email and handle\.$/,
  wait_then_retry: /^Next: wait \d+ seconds, then call agentchat_(register|verify_otp) /,
  // A long wait names it; a server failure names the step to repeat.
  stop: /^Next: (wait \d+ seconds, then )?call agentchat_(register|verify_otp) /,
}

describe('the fixture covers the contract’s sign-up table', () => {
  it('names are unique, every action is known, and each tool’s route has its cases', () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length)
    for (const c of CASES) expect(['done', 'ask_code', 'ask_param', 'offer_new_code', 'wait_then_retry', 'stop'], c.name).toContain(c.expected.action)
    expect(REGISTER_CODES.sort()).toEqual(
      ['EMAIL_EXHAUSTED', 'EMAIL_LIMIT_REACHED', 'HANDLE_TAKEN', 'INTERNAL_ERROR', 'INVALID_HANDLE', 'OTP_COOLDOWN', 'OTP_FAILED', 'OTP_HOURLY_CAP', 'RATE_LIMITED', 'VALIDATION_ERROR'],
    )
    expect(VERIFY_CODES.sort()).toEqual(
      ['EMAIL_EXHAUSTED', 'EMAIL_LIMIT_REACHED', 'EXPIRED', 'HANDLE_TAKEN', 'INTERNAL_ERROR', 'INVALID_CODE', 'OTP_ATTEMPTS_EXHAUSTED', 'OTP_EMAIL_LOCKED', 'RATE_LIMITED', 'VALIDATION_ERROR'],
    )
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s: the flow read from the body is the expected one', (_name, c) => {
    expect(readPart(c.expected.flow), 'the fixture’s expected flow is the body’s').toEqual(
      readPart((typeof c.body['code'] === 'string' ? c.body['details'] : c.body) as Record<string, unknown>),
    )
    expect(flowOf(c.body)).toEqual(readPart(c.expected.flow))
  })
})

describe('each server answer reaches the model as the server said it', () => {
  for (const c of TOOL_CASES.filter((tc) => tc.expected.text !== null)) {
    it(`${c.name}: the exact text`, async () => {
      expect(await textOf(c)).toBe(c.expected.text)
    })

    it(`${c.name}: the server’s code and message verbatim, a Next line for ${c.expected.action}, the facts present`, async () => {
      const shown = await textOf(c)
      const code = c.body['code']
      if (typeof code === 'string') {
        // The server's own code, whatever the HTTP status (a 5xx included).
        expect(shown.startsWith(`Error: ${code}\n\n${c.body['message'] as string}\nNext: `), shown).toBe(true)
      } else {
        expect(shown.startsWith(`${c.body['message'] as string}\nNext: `), shown).toBe(true)
      }
      expect(nextLineOf(shown)).toMatch(ACTION_NEXT[c.expected.action as Exclude<Action, 'done'>])
      const flow = c.expected.flow
      const retry = typeof flow['retry_after_s'] === 'number' ? flow['retry_after_s'] : 0
      if (retry > 0) expect(shown).toContain(`\n\nRetry after: ${retry} seconds.`)
      else expect(shown).not.toContain('Retry after:')
      if (flow['limit'] !== undefined) expect(shown).toContain(`\nLimit: ${String(flow['limit'])}.`)
      if (flow['param'] !== undefined) expect(shown).toContain(`\nInput to change: \`${String(flow['param'])}\`.`)
      // No rulebook of the tool's own: none of the fallback guidance shows.
      const guidance = c.request === 'register' ? registerAccount.GUIDANCE : verifyOtp.GUIDANCE
      for (const text of Object.values(guidance)) expect(shown).not.toContain(text)
    })
  }

  it('register success adds the one agent line, naming the email it was sent to', async () => {
    const sent = CASES.find((c) => c.name === 'register: code sent')!
    const shown = await textOf(sent)
    expect(shown.split('\n')).toEqual([
      'We sent a 6-digit code to owner@example.com. It expires in 10 minutes.',
      'Next: call agentchat_verify_otp with pending_id `pnd_1` and the 6-digit code.',
      "If you can't read owner@example.com yourself, ask the user for the code.",
    ])
  })

  it.each(OTHER_CASES.map((c) => [c.name, c] as const))('%s: a step no tool here makes points to the manual', (_name, c) => {
    const flow = flowOf(c.body)!
    expect(renderFlow(c.body['message'] as string, flow)).toBe(c.expected.text)
    expect(nextLine(flow)).toMatch(/no tool here does that, see “(Lost key — recovery|API key rotation)” at https:\/\/agentchat\.me\/skill\.md#(lost-key--recovery|api-key-rotation)\.$/)
  })
})

describe('the Next line names tools as the session’s runtime shows them', () => {
  const spell = (tool: string) => `mcp__agentchat__${tool}`

  it('through the context’s namer, in success and error answers', async () => {
    const sent = CASES.find((c) => c.name === 'register: code sent')!
    const wrong = CASES.find((c) => c.name === 'verify: 400 INVALID_CODE (attempts left)')!
    const taken = CASES.find((c) => c.name === 'register: 409 HANDLE_TAKEN')!
    expect(nextLineOf(await textOf(sent, { nameTool: spell }))).toBe(
      'Next: call mcp__agentchat__agentchat_verify_otp with pending_id `pnd_1` and the 6-digit code.',
    )
    expect(nextLineOf(await textOf(wrong, { nameTool: spell }))).toBe(
      'Next: call mcp__agentchat__agentchat_verify_otp with pending_id `pnd_1` and the 6-digit code.',
    )
    expect(nextLineOf(await textOf(taken, { nameTool: spell }))).toBe(
      'Next: call mcp__agentchat__agentchat_register again with a different `handle`.',
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('buildMcpServer hands its toolNamer to the sign-up tools', async () => {
    const cooldown = CASES.find((c) => c.name === 'register: 429 OTP_COOLDOWN')!
    vi.stubGlobal('fetch', (async () => answerOf(cooldown)()) as typeof fetch)
    const server = buildMcpServer({ apiBase: 'https://namer.agentchat.test', apiKey: null, toolNamer: (tool) => `agentchat__${tool}` })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'registration-codes', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    try {
      const result = await client.callTool({ name: 'agentchat_register', arguments: { email: 'owner@example.com', handle: 'fresh-bot' } })
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
  const success = CASES.find((c) => c.name === 'verify: 201 success')!

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('with agentchatme 1.3.x (key and agent only): the answer as before, key and handle from the server', async () => {
    const payload = JSON.parse(await verifyText(answerOf(success))) as Record<string, unknown>
    expect(payload['ok']).toBe(true)
    expect(payload['api_key']).toBe('ac_live_minted')
    expect(payload['handle']).toBe('fresh-bot')
    expect(payload['message']).toBeUndefined()
    expect(String(payload['important'])).toContain('exactly once')
  })

  it('with an SDK whose verify result carries the flow fields: the server’s message comes first', async () => {
    vi.spyOn(AgentChatClient, 'verify').mockResolvedValue({
      agent: { handle: 'fresh-bot' },
      apiKey: 'ac_live_minted',
      client: {} as AgentChatClient,
      message: 'Email verified. Logged in as @fresh-bot.',
      next_step: 'done',
      status: 'approved',
    } as Awaited<ReturnType<typeof AgentChatClient.verify>>)
    const payload = JSON.parse(await verifyText(() => json(500, {}))) as Record<string, unknown>
    expect(Object.keys(payload).slice(0, 4)).toEqual(['ok', 'message', 'handle', 'api_key'])
    expect(payload['message']).toBe('Email verified. Logged in as @fresh-bot.')
    expect(payload['handle']).toBe('fresh-bot')
  })
})

// ─── The fallback: a server that sends no next_step ────────────────────────

/**
 * Capitalized words in these texts that are not error codes. A new one has
 * to be added here (or to the fixture's codes) on purpose.
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
        if (code === 'OTP_FAILED' || code === 'INTERNAL_ERROR') {
          expect(tool.module.GUIDANCE[code], `${tool.name}: ${code} is a 5xx`).toBeUndefined()
          continue
        }
        expect(tool.module.GUIDANCE[code], `${tool.name} has fallback guidance for ${code}`).toBeTruthy()
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

  it('register success without a flow object: the answer as before', async () => {
    const payload = JSON.parse(await registerText(() => json(200, { pending_id: 'pnd_1', message: 'sent' }))) as Record<string, unknown>
    expect(payload).toMatchObject({ ok: true, pending_id: 'pnd_1', message: 'sent' })
    expect(String(payload['next_step'])).toContain('Call agentchat_verify_otp with this pending_id')
  })
})

describe('an earlier verify that may have created the account', () => {
  it('a 2xx without a key gives the recovery step, and never says to verify again', async () => {
    const noKey = await verifyText(() => json(201, { agent: { handle: 'fresh-bot' } }))
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
