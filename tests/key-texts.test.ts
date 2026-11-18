import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { UnauthorizedError } from 'agentchatme'
import { describe, expect, it } from 'vitest'
import { NotAuthenticatedError, NotRegisteredError } from '../src/client.js'
import { IdentityConflictError } from '../src/env.js'
import { mapAgentChatError } from '../src/errors.js'
import { buildInstructions, type ServerMode } from '../src/instructions.js'
import { buildMcpServer } from '../src/lib.js'
import { RECOVER_THE_KEY } from '../src/tools/_texts.js'
import { visibleToolNames, type ToolVisibility } from '../src/tools/index.js'
import * as registerAccount from '../src/tools/register.js'
import * as verifyOtp from '../src/tools/verify-otp.js'
import { fetchStub, json, makeRealCtx } from './tools/_real-client.js'

// ─── No text tells an agent to put its key on a command line or in an env ──
//
// Lab round 1 (T2-F01, T2-F08): the verify tool's `store_the_key` recipes
// and the NOT_REGISTERED error told the model to run `claude mcp add …
// --header "Authorization: Bearer <api_key>"`, `agentchat login --api-key
// <api_key>` or to set AGENTCHAT_API_KEY=<api_key>; the model tried it with
// the real key. A command line is readable by every user of the machine
// (`ps`) and kept in shell history; an environment variable reaches every
// program started from it. Every text a model can read is swept here:
// tool and parameter descriptions, the server instructions in every
// situation, the identity errors, and the sign-up answers.

/** A key, or a stand-in for one, written where a command line or an environment would carry it. */
const KEY_ON_ARGV_OR_ENV: ReadonlyArray<[string, RegExp]> = [
  // `--api-key <key>` / `--api-key=ac_…` (but `--api-key -`, the key on stdin, is the fix)
  ['--api-key with a value', /--api-key[ =]+(?!-(?:[\s`'".,;)]|$))/],
  ['--header carrying the key', /--header\s+["']?Authorization:\s*Bearer\s+(?:<api[_ ]key>|ac_)/i],
  ['--token with a value', /--token[ =]+\S/],
  ['an assignment of the key to the environment', /AGENTCHAT_API_KEY=/],
  ['advice to keep the key in the environment', /\b(?:set|store|put|export|keep)\b[^.;]{0,40}\bAGENTCHAT_API_KEY\b/i],
  ['an echo or printf of the key', /\b(?:echo|printf)\b[^`]{0,20}(?:<api[_ ]key>|ac_)/i],
]

function offences(label: string, text: string): string[] {
  return KEY_ON_ARGV_OR_ENV.filter(([, pattern]) => pattern.test(text)).map(([what]) => `${label}: ${what}`)
}

/** Every string inside a JSON value, unescaped (a JSON text would hide `--header "…"` behind `\"`). */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsOf)
  return []
}

const SITUATIONS: ReadonlyArray<[string, ToolVisibility | undefined]> = [
  ['full surface', undefined],
  ['unregistered', { registered: false, webhookTools: false }],
  ['registered', { registered: true, webhookTools: false }],
  ['registered + webhook', { registered: true, webhookTools: true }],
]

async function listedTexts(): Promise<Array<[string, string]>> {
  const server = buildMcpServer({ apiBase: 'https://key-texts.invalid', apiKey: null })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'key-texts', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  try {
    return (await client.listTools()).tools.flatMap((tool) => stringsOf(tool).map((text): [string, string] => [tool.name, text]))
  } finally {
    await client.close()
  }
}

async function hostedVerifyAnswer(): Promise<string> {
  const { impl } = fetchStub(() => json(200, { api_key: 'ac_live_minted_0000000000000000', agent: { handle: 'new-bot' } }))
  const result = await verifyOtp.createHandler(makeRealCtx(impl, { apiKey: null, mode: 'hosted' }))({ pending_id: 'pnd_1', code: '123456' })
  return (result.content as Array<{ text: string }>)[0]!.text
}

describe('no text puts the key on a command line or in an environment variable', () => {
  it('tool and parameter descriptions', async () => {
    const found = (await listedTexts()).flatMap(([name, text]) => offences(name, text))
    expect(found).toEqual([])
  })

  it('the server instructions, in every composition and situation', () => {
    const found: string[] = []
    for (const mode of ['stdio', 'hosted'] as ServerMode[]) {
      for (const [situation, visibility] of SITUATIONS) {
        found.push(...offences(`${mode}/${situation}`, buildInstructions(mode, visibleToolNames(visibility).length, visibility)))
      }
    }
    expect(found).toEqual([])
  })

  it('the identity errors', () => {
    const unauthorized = new UnauthorizedError({ code: 'UNAUTHORIZED', message: 'unauthorized' }, 401)
    const texts: Array<[string, string]> = [
      ['NOT_REGISTERED', mapAgentChatError(new NotRegisteredError(), 'stdio').message],
      ['NOT_AUTHENTICATED', mapAgentChatError(new NotAuthenticatedError(), 'hosted').message],
      ['UNAUTHORIZED/stdio', mapAgentChatError(unauthorized, 'stdio').message],
      ['UNAUTHORIZED/hosted', mapAgentChatError(unauthorized, 'hosted').message],
      ['IDENTITY_CONFLICT/differs', mapAgentChatError(new IdentityConflictError('differs', '/h', 'me'), 'stdio').message],
      ['IDENTITY_CONFLICT/home_empty', mapAgentChatError(new IdentityConflictError('home_empty', '/h', null), 'stdio').message],
      ['RECOVER_THE_KEY', RECOVER_THE_KEY],
      ...Object.entries(verifyOtp.GUIDANCE).map(([code, text]): [string, string] => [`verify ${code}`, text]),
      ...Object.entries(registerAccount.GUIDANCE).map(([code, text]): [string, string] => [`register ${code}`, text]),
    ]
    expect(texts.flatMap(([label, text]) => offences(label, text))).toEqual([])
    // The stdio sign-in error names the tools, and the CLI's stdin form.
    expect(texts[0]![1]).toContain('agentchat_register')
    expect(texts[0]![1]).toContain('`agentchat login --api-key -`')
  })

  it('the hosted verify answer: every recipe places the key through settings, a file editor or stdin', async () => {
    const answer = await hostedVerifyAnswer()
    expect(stringsOf(JSON.parse(answer)).flatMap((text) => offences('verify answer', text))).toEqual([])
    const recipes = (JSON.parse(answer) as { store_the_key: Record<string, string> }).store_the_key
    for (const [host, recipe] of Object.entries(recipes)) {
      // A placeholder for the key appears only as a header value set in a settings screen or config file.
      for (const span of recipe.match(/`[^`]+`/g) ?? []) {
        if (span.includes('<api_key>')) expect(span, `${host}: ${span}`).toMatch(/^`Authorization: Bearer <api_key>`$/)
      }
      expect(recipe.replace(/`[^`]+`/g, ''), host).not.toContain('<api_key>')
    }
    // A command that takes the key reads it from a file on stdin.
    expect(recipes['claude_code']).toContain('login --api-key - < ~/.agentchat-key/key')
    expect(recipes['codex']).toContain('login --api-key - < ~/.agentchat-key/key')
    expect(recipes['key_file']).toContain('mkdir -p -m 700 ~/.agentchat-key')
    expect(recipes['key_file']).toContain('with your file-editing tool (not a shell command)')
    expect(recipes['never']).toContain('Never put the key on a command line')
  })
})
