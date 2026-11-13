import { type AgentChatClient } from 'agentchatme'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { NotRegisteredError } from '../../src/client.js'
import { buildMcpServer } from '../../src/lib.js'
import { Semaphore } from '../../src/semaphore.js'
import * as registerAccount from '../../src/tools/register.js'
import * as verifyOtp from '../../src/tools/verify-otp.js'
import { RECOVER_THE_KEY } from '../../src/tools/_texts.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Sign-up errors: only codes the server sends, each with its next step ──
//
// An agent with no integration onboards through exactly these two tools, so
// what they say about an error is the advice it gets at its first step. They
// once named EMAIL_TAKEN, CODE_EXPIRED and PENDING_NOT_FOUND, which the
// server never sends, and said nothing about the codes it does send.
//
// The lists below are the server's, copied from the AgentChat API (read
// 2026-11-12): every code POST /v1/register and POST /v1/register/verify
// answer with, including the per-address limiter in front of both routes,
// the per-email code-send and code-verify limits, and the last-resort
// handler. Status, Retry-After and the message are as the server sends them
// (the numbers in a message are the server's current settings, shown as an
// example of its shape). When the server changes these routes, change the
// list here first; the tests then say which tool text to change.

interface ServerCode {
  status: number
  /** Seconds, when the server sends a Retry-After header with this code. */
  retryAfter?: number
  /** The server's message. */
  message: string
  /** When the server sends it. */
  when: string
}

const REGISTER_CODES: Record<string, ServerCode> = {
  VALIDATION_ERROR: { status: 400, message: 'Invalid request', when: 'the body is not JSON, or fails the request schema' },
  INVALID_HANDLE: { status: 400, message: 'Handle is invalid or reserved', when: 'the handle is not valid or is reserved' },
  HANDLE_TAKEN: { status: 409, message: 'Handle @fresh-bot is already taken', when: 'another agent has this handle' },
  EMAIL_LIMIT_REACHED: { status: 409, message: 'This email already backs 10 active agents. Delete one, or register with a different email.', when: 'the email already backs as many live agents as it may (details.limit)' },
  EMAIL_EXHAUSTED: { status: 409, message: 'This email has reached the maximum of 30 account registrations.', when: 'the email has used all its lifetime registrations (details.limit)' },
  OTP_COOLDOWN: { status: 429, retryAfter: 42, message: 'Please wait 42s before requesting another code.', when: 'a code went to this email within the send cooldown' },
  OTP_HOURLY_CAP: { status: 429, retryAfter: 1800, message: 'Maximum 20 verification codes per hour. Please try again later.', when: 'this email was sent too many codes this hour' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Try again in 3600 seconds.', when: 'too many register requests from this network address (no Retry-After)' },
  OTP_FAILED: { status: 500, message: 'Failed to send verification code', when: 'the code email could not be sent' },
  INTERNAL_ERROR: { status: 500, message: 'An unexpected error occurred', when: 'an unexpected server error' },
}

const VERIFY_CODES: Record<string, ServerCode> = {
  VALIDATION_ERROR: { status: 400, message: 'Invalid request', when: 'the body is not JSON, or fails the request schema' },
  EXPIRED: { status: 400, message: 'Registration expired or invalid. Please start again.', when: 'no pending registration has this pending_id: expired, completed, cancelled, or never issued' },
  OTP_ATTEMPTS_EXHAUSTED: { status: 429, message: 'Too many incorrect codes (max 5). Please request a new one.', when: 'too many wrong codes for this pending_id; the pending registration is cancelled (no Retry-After)' },
  OTP_EMAIL_LOCKED: { status: 429, retryAfter: 900, message: 'Too many wrong codes for this email. Try again in 15 minutes.', when: 'too many codes tried for this email, across its code flows' },
  INVALID_CODE: { status: 400, message: 'Invalid or expired verification code', when: 'the code is wrong or expired' },
  HANDLE_TAKEN: { status: 409, message: 'Handle @fresh-bot is already taken', when: 'the handle was taken between register and verify (the pending registration is used up)' },
  EMAIL_LIMIT_REACHED: { status: 409, message: 'This email already backs 10 active agents. Delete one, or register with a different email.', when: 'another registration with this email finished first and filled its live slots' },
  EMAIL_EXHAUSTED: { status: 409, message: 'This email has reached the maximum of 30 account registrations.', when: 'another registration with this email finished first and spent its last registration' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Try again in 600 seconds.', when: 'too many verify requests from this network address (no Retry-After)' },
  INTERNAL_ERROR: { status: 500, message: 'An unexpected error occurred', when: 'an unexpected server error' },
}

/**
 * Capitalized words in these texts that are not error codes. A new one has
 * to be added here (or to a code list above) on purpose.
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

// ── the real pipeline: SDK call over a stubbed fetch → typed error → mapped text

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })

function makeCtx(respond: () => Response): ToolContext {
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
  } as unknown as ToolContext
}

function serverAnswer(code: string, spec: ServerCode): Response {
  return json(
    spec.status,
    { code, message: spec.message },
    spec.retryAfter !== undefined ? { 'retry-after': String(spec.retryAfter) } : {},
  )
}

async function registerText(answer: () => Response): Promise<string> {
  const result = await registerAccount.createHandler(makeCtx(answer))({ email: 'owner@example.com', handle: 'fresh-bot' })
  return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n')
}

async function verifyText(answer: () => Response): Promise<string> {
  const result = await verifyOtp.createHandler(makeCtx(answer))({ pending_id: 'pnd_1', code: '123456' })
  return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n')
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

/** The code the model branches on: the server's own, except a 5xx, which the error mapper names SERVER_ERROR. */
function shownCode(code: string, spec: ServerCode): string {
  return spec.status >= 500 ? 'SERVER_ERROR' : code
}

const TOOLS = [
  { name: registerAccount.NAME, module: registerAccount, codes: REGISTER_CODES, text: registerText },
  { name: verifyOtp.NAME, module: verifyOtp, codes: VERIFY_CODES, text: verifyText },
] as const

describe('the sign-up tools name only codes the server sends', () => {
  function expectOnlyServerCodes(tool: (typeof TOOLS)[number], where: string, text: string) {
    for (const word of capitalizedWords(text)) {
      if (NOT_CODES.has(word)) continue
      expect(Object.keys(tool.codes), `${tool.name} ${where} names ${word}`).toContain(word)
    }
  }

  it('every capitalized word in each description and parameter text is a server code of that route, or a known non-code', async () => {
    const schemas = await inputSchemas()
    for (const tool of TOOLS) {
      expectOnlyServerCodes(tool, 'description', tool.module.DESCRIPTION)
      expectOnlyServerCodes(tool, 'parameters', schemas.get(tool.name)!)
    }
  })

  it('every capitalized word in the guidance is a server code of that route, or a known non-code', () => {
    for (const tool of TOOLS) {
      const guidance = (tool.module as { GUIDANCE?: Record<string, string> }).GUIDANCE
      expect(guidance, `${tool.name} exports its GUIDANCE`).toBeDefined()
      for (const [code, text] of Object.entries(guidance ?? {})) expectOnlyServerCodes(tool, `guidance for ${code}`, text)
    }
  })

  it('guidance is keyed only by codes the route sends, and covers every one the model sees under its own code', () => {
    for (const tool of TOOLS) {
      const guidance = (tool.module as { GUIDANCE?: Record<string, string> }).GUIDANCE ?? {}
      for (const code of Object.keys(guidance)) {
        expect(Object.keys(tool.codes), `${tool.name} guides ${code}`).toContain(code)
      }
      for (const [code, spec] of Object.entries(tool.codes)) {
        // A 5xx reaches the model as SERVER_ERROR ("transient; retry shortly"),
        // whatever the wire code: guidance keyed by it would never be read.
        if (spec.status >= 500) {
          expect(guidance[code], `${tool.name}: ${code} is a 5xx`).toBeUndefined()
          continue
        }
        expect(guidance[code], `${tool.name} has guidance for ${code} (${spec.when})`).toBeTruthy()
      }
    }
  })

  it('the success texts name no code outside the lists', async () => {
    const minted = await verifyText(() => json(201, { api_key: 'ac_minted', agent: { handle: 'fresh-bot' } }))
    const pending = await registerText(() => json(200, { pending_id: 'pnd_1', message: 'sent' }))
    for (const [name, text, codes] of [
      ['agentchat_verify_otp', minted, VERIFY_CODES],
      ['agentchat_register', pending, REGISTER_CODES],
    ] as const) {
      for (const word of capitalizedWords(text.replace(/ac_minted/g, ''))) {
        if (NOT_CODES.has(word)) continue
        expect(Object.keys(codes), `${name} success text names ${word}`).toContain(word)
      }
    }
  })
})

// What the model reads for each server answer, and the next step it is given.
const REGISTER_NEXT: Record<string, RegExp> = {
  VALIDATION_ERROR: /Check the arguments: `email` is one email address, `handle` 3-30 lowercase letters/,
  INVALID_HANDLE: /reserved or not a valid handle\. Pick a different handle and call agentchat_register again/,
  HANDLE_TAKEN: /Pick a different handle and call agentchat_register again .*— unless it is the handle you just registered and an earlier agentchat_verify_otp got no answer or no key: then the account exists, so keep the handle\. Recover its key/,
  EMAIL_LIMIT_REACHED: /already backs as many live agents as it may\. Register with a different email address .*or delete one of the agents this email backs/,
  EMAIL_EXHAUSTED: /used all of its registrations \(deleted agents count too\).*Register with a different email address/,
  OTP_COOLDOWN: /A code was emailed to this address moments ago\. If you have the pending_id from that call, use that code with agentchat_verify_otp; otherwise wait the retry time, then call agentchat_register again/,
  OTP_HOURLY_CAP: /Too many codes were emailed to this address in the last hour\..*agentchat_verify_otp.*wait the retry time before calling agentchat_register again/,
  RATE_LIMITED: /^Rate limit exceeded\. Too many requests\. Try again in 3600 seconds\. Too many sign-up requests came from this network address .*Wait before calling agentchat_register again/m,
  OTP_FAILED: /^AgentChat reported a server-side error\. This is transient; retry shortly\.$/m,
  INTERNAL_ERROR: /^AgentChat reported a server-side error\. This is transient; retry shortly\.$/m,
}

const VERIFY_NEXT: Record<string, RegExp> = {
  VALIDATION_ERROR: /Check the arguments: `pending_id` exactly as agentchat_register returned it, `code` the 6 digits from the email/,
  EXPIRED: /No pending registration has this pending_id any more.*If an earlier agentchat_verify_otp returned your API key, you are registered — use that key\. If the registration expired or wrong codes cancelled it, call agentchat_register again for a new pending_id and code\. But if an earlier verify got no answer, or an answer without a key, the account may exist, so do not register another handle\. Recover its key/,
  OTP_ATTEMPTS_EXHAUSTED: /Too many wrong codes were tried, so this registration is cancelled\. Call agentchat_register again/,
  OTP_EMAIL_LOCKED: /Too many codes were tried for this email.*Wait the retry time before calling agentchat_verify_otp again; registering again does not lift the wait/,
  INVALID_CODE: /Re-check the 6 digits from the NEWEST verification email and try again.*OTP_ATTEMPTS_EXHAUSTED/,
  HANDLE_TAKEN: /The code was right, but the handle was taken first, so this registration is used up: call agentchat_register again with a different handle — unless an earlier agentchat_verify_otp of yours for this handle got no answer or no key; then that account is yours, so keep the handle\. Recover its key/,
  EMAIL_LIMIT_REACHED: /The code was right, but another registration with this email finished first.*Call agentchat_register again with a different email address/,
  EMAIL_EXHAUSTED: /The code was right, but another registration with this email finished first.*Call agentchat_register again with a different email address/,
  RATE_LIMITED: /^Rate limit exceeded\. Too many requests\. Try again in 600 seconds\. Too many verification requests came from this network address .*Wait before calling agentchat_verify_otp again/m,
  INTERNAL_ERROR: /^AgentChat reported a server-side error\. This is transient; retry shortly\.$/m,
}

describe('each server answer reaches the model with its code and the right next step', () => {
  for (const [tool, codes, next, text] of [
    ['agentchat_register', REGISTER_CODES, REGISTER_NEXT, registerText],
    ['agentchat_verify_otp', VERIFY_CODES, VERIFY_NEXT, verifyText],
  ] as const) {
    it(`${tool}: every code in the server's list is covered here`, () => {
      expect(Object.keys(next).sort()).toEqual(Object.keys(codes).sort())
    })

    for (const [code, spec] of Object.entries(codes)) {
      it(`${tool}: ${spec.status} ${code} — ${spec.when}`, async () => {
        const shown = await text(() => serverAnswer(code, spec))
        expect(shown.startsWith(`Error: ${shownCode(code, spec)}\n`), shown).toBe(true)
        // The server's own words survive (for RATE_LIMITED too: with no
        // Retry-After they are the only place the wait is stated), each as
        // its own sentence before the guidance.
        if (spec.status < 500) {
          const sentence = /[.!?]$/.test(spec.message) ? spec.message : `${spec.message}.`
          expect(shown, shown).toContain(`${sentence} `)
        }
        expect(shown).toMatch(next[code]!)
        // The retry time is shown exactly when the server sends one.
        if (spec.retryAfter !== undefined) expect(shown).toContain(`Retry after: ${spec.retryAfter} seconds.`)
        else expect(shown).not.toContain('Retry after:')
      })
    }
  }
})

describe('an earlier verify that may have created the account', () => {
  it('EXPIRED, a 2xx without a key and HANDLE_TAKEN on the handle you just registered all give the recovery step; none says to verify again', async () => {
    const expired = await verifyText(() => serverAnswer('EXPIRED', VERIFY_CODES['EXPIRED']!))
    const noKey = await verifyText(() => json(201, { agent: { handle: 'fresh-bot' } }))
    const takenAtRegister = await registerText(() => serverAnswer('HANDLE_TAKEN', REGISTER_CODES['HANDLE_TAKEN']!))
    const takenAtVerify = await verifyText(() => serverAnswer('HANDLE_TAKEN', VERIFY_CODES['HANDLE_TAKEN']!))
    for (const [name, text] of [['EXPIRED', expired], ['no key', noKey], ['register HANDLE_TAKEN', takenAtRegister], ['verify HANDLE_TAKEN', takenAtVerify]] as const) {
      expect(text, name).toContain(RECOVER_THE_KEY)
      expect(text, name).not.toMatch(/retry agentchat_verify_otp/i)
    }
    // The server said success: the account exists, under a handle the agent keeps.
    expect(noKey).toContain('the account exists with a key you do not hold')
    expect(noKey).toContain('Do not register another handle.')
    expect(verifyOtp.DESCRIPTION).toContain('the account may exist: recover its key with the handle and email, and do not register another handle')
    expect(registerAccount.DESCRIPTION).toContain('unless HANDLE_TAKEN names the handle you just registered after a verify that got no answer: then recover its key')
    for (const word of capitalizedWords(noKey)) {
      if (NOT_CODES.has(word) || word === 'INTERNAL_ERROR') continue
      expect(Object.keys(VERIFY_CODES), `no-key text names ${word}`).toContain(word)
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
    // Recovery answers the same and sends nothing within a minute of another
    // code to the same email (a sign-up code counts), past the hourly cap, or
    // when the send fails: a missing code proves nothing.
    expect(RECOVER_THE_KEY).toContain('No code is sent within a minute of another code to the same email (a sign-up code counts): wait a minute and ask once more.')
    expect(RECOVER_THE_KEY).toContain('A missing code never means the account is missing; if none comes, ask your operator.')
    expect(RECOVER_THE_KEY).not.toMatch(/no account was created|register again/i)
  })
})
