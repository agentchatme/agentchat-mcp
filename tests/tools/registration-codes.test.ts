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
// handler. Status and Retry-After are as the server sends them. When the
// server changes these routes, change the list here first; the tests then
// say which tool text to change.

interface ServerCode {
  status: number
  /** Seconds, when the server sends a Retry-After header with this code. */
  retryAfter?: number
  /** When the server sends it. */
  when: string
}

const REGISTER_CODES: Record<string, ServerCode> = {
  VALIDATION_ERROR: { status: 400, when: 'the body is not JSON, or fails the request schema' },
  INVALID_HANDLE: { status: 400, when: 'the handle is not valid or is reserved' },
  HANDLE_TAKEN: { status: 409, when: 'another agent has this handle' },
  EMAIL_LIMIT_REACHED: { status: 409, when: 'the email already backs as many live agents as it may (details.limit)' },
  EMAIL_EXHAUSTED: { status: 409, when: 'the email has used all its lifetime registrations (details.limit)' },
  OTP_COOLDOWN: { status: 429, retryAfter: 42, when: 'a code went to this email within the send cooldown' },
  OTP_HOURLY_CAP: { status: 429, retryAfter: 1800, when: 'this email was sent too many codes this hour' },
  RATE_LIMITED: { status: 429, when: 'too many register requests from this network address (no Retry-After)' },
  OTP_FAILED: { status: 500, when: 'the code email could not be sent' },
  INTERNAL_ERROR: { status: 500, when: 'an unexpected server error' },
}

const VERIFY_CODES: Record<string, ServerCode> = {
  VALIDATION_ERROR: { status: 400, when: 'the body is not JSON, or fails the request schema' },
  EXPIRED: { status: 400, when: 'no pending registration has this pending_id: expired, completed, cancelled, or never issued' },
  OTP_ATTEMPTS_EXHAUSTED: { status: 429, when: 'too many wrong codes for this pending_id; the pending registration is cancelled (no Retry-After)' },
  OTP_EMAIL_LOCKED: { status: 429, retryAfter: 900, when: 'too many codes tried for this email, across its code flows' },
  INVALID_CODE: { status: 400, when: 'the code is wrong or expired' },
  HANDLE_TAKEN: { status: 409, when: 'the handle was taken between register and verify (the pending registration is used up)' },
  EMAIL_LIMIT_REACHED: { status: 409, when: 'another registration with this email finished first and filled its live slots' },
  EMAIL_EXHAUSTED: { status: 409, when: 'another registration with this email finished first and spent its last registration' },
  RATE_LIMITED: { status: 429, when: 'too many verify requests from this network address (no Retry-After)' },
  INTERNAL_ERROR: { status: 500, when: 'an unexpected server error' },
}

/**
 * Capitalized words in these texts that are not error codes. A new one has
 * to be added here (or to a code list above) on purpose.
 */
const NOT_CODES: ReadonlySet<string> = new Set([
  'API', // "API key"
  'MCP', // "MCP server", "MCP client"
  'AGENTCHAT_API_KEY', // the stdio server's environment variable
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
    { code, message: `server message for ${code.toLowerCase()}` },
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
  HANDLE_TAKEN: /Pick a different handle and call agentchat_register again/,
  EMAIL_LIMIT_REACHED: /already backs as many live agents as it may\. Register with a different email address .*or delete one of the agents this email backs/,
  EMAIL_EXHAUSTED: /used all of its registrations \(deleted agents count too\).*Register with a different email address/,
  OTP_COOLDOWN: /A code was emailed to this address moments ago\. If you have the pending_id from that call, use that code with agentchat_verify_otp; otherwise wait the retry time, then call agentchat_register again/,
  OTP_HOURLY_CAP: /Too many codes were emailed to this address in the last hour\..*agentchat_verify_otp.*wait the retry time before calling agentchat_register again/,
  RATE_LIMITED: /^Rate limit exceeded\. Too many sign-up requests came from this network address .*Wait before calling agentchat_register again/m,
  OTP_FAILED: /^AgentChat reported a server-side error\. This is transient; retry shortly\.$/m,
  INTERNAL_ERROR: /^AgentChat reported a server-side error\. This is transient; retry shortly\.$/m,
}

const VERIFY_NEXT: Record<string, RegExp> = {
  VALIDATION_ERROR: /Check the arguments: `pending_id` exactly as agentchat_register returned it, `code` the 6 digits from the email/,
  EXPIRED: /No pending registration has this pending_id any more.*If an earlier agentchat_verify_otp already returned your API key, you are registered — use that key\. Otherwise call agentchat_register again/,
  OTP_ATTEMPTS_EXHAUSTED: /Too many wrong codes were tried, so this registration is cancelled\. Call agentchat_register again/,
  OTP_EMAIL_LOCKED: /Too many codes were tried for this email.*Wait the retry time before calling agentchat_verify_otp again; registering again does not lift the wait/,
  INVALID_CODE: /Re-check the 6 digits from the NEWEST verification email and try again.*OTP_ATTEMPTS_EXHAUSTED/,
  HANDLE_TAKEN: /The code was right, but another agent took this handle first.*Call agentchat_register again with a different handle/,
  EMAIL_LIMIT_REACHED: /The code was right, but another registration with this email finished first.*Call agentchat_register again with a different email address/,
  EMAIL_EXHAUSTED: /The code was right, but another registration with this email finished first.*Call agentchat_register again with a different email address/,
  RATE_LIMITED: /^Rate limit exceeded\. Too many verification requests came from this network address .*Wait before calling agentchat_verify_otp again/m,
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
        // The server's own words survive wherever the mapper keeps them.
        if (spec.status < 500 && code !== 'RATE_LIMITED') {
          expect(shown).toContain(`server message for ${code.toLowerCase()}`)
        }
        expect(shown).toMatch(next[code]!)
        // The retry time is shown exactly when the server sends one.
        if (spec.retryAfter !== undefined) expect(shown).toContain(`Retry after: ${spec.retryAfter} seconds.`)
        else expect(shown).not.toContain('Retry after:')
      })
    }
  }
})
