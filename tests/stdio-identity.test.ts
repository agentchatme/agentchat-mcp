import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityProvider } from '../src/client.js'
import { loadConfig, saveCredentials } from '../src/env.js'
import { buildServer } from '../src/server.js'
import { fetchStub, json, pathOf, type FetchCall } from './tools/_real-client.js'

// ─── The stdio server's identity, end to end ───────────────────────────────
//
// The real stdio composition (src/server.ts with the IdentityProvider) over
// an in-memory MCP transport, the network stubbed at globalThis.fetch (what
// the provider's clients use). Two leak paths from lab round 1:
//
//   * T2-F10: an AGENTCHAT_API_KEY exported in the shell silently made a
//     stdio entry whose AGENTCHAT_HOME holds one agent act as another.
//   * T2-F01: sign-up through the tools handed the key to the model with a
//     recipe that put it on a command line; the stdio server now saves the
//     key in its home itself and never shows it.

const KEY_HOME = 'ac_live_home0000000000000000000000000000'
const KEY_ENV = 'ac_live_env11111111111111111111111111111'
const KEY_NEW = 'ac_live_new22222222222222222222222222222'
const API = 'https://api.agentchat.test'

let root: string
let home: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acmcp-stdio-id-'))
  home = path.join(root, 'home')
  // Nothing ambient decides the outcome: the default home is empty too.
  vi.stubEnv('HOME', path.join(root, 'user'))
  vi.stubEnv('USERPROFILE', path.join(root, 'user'))
  vi.stubEnv('AGENTCHAT_API_KEY', '')
  vi.stubEnv('AGENTCHAT_API_BASE', API)
  vi.stubEnv('AGENTCHAT_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fs.rmSync(root, { recursive: true, force: true })
})

const me = (handle: string) => ({
  handle,
  display_name: null,
  description: null,
  status: 'active',
  paused_by_owner: 'none',
  settings: { inbox_mode: 'open', group_invite_policy: 'open' },
})

function writeHomeCreds(contents: unknown): string {
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, 'credentials')
  fs.writeFileSync(file, JSON.stringify(contents))
  return file
}

/** The stdio composition, connected to an in-memory client, with the network answered by `respond`. */
async function stdio(respond: (call: FetchCall) => Response) {
  const stub = fetchStub(respond)
  vi.stubGlobal('fetch', stub.impl)
  const config = loadConfig({ AGENTCHAT_API_BASE: API, AGENTCHAT_LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv)
  const logger = pino({ level: 'silent' })
  const provider = new IdentityProvider(config, logger)
  const built = buildServer(provider, config, logger)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'stdio-identity', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n')
    return { isError: result.isError === true, text }
  }
  return { calls: stub.calls, call, provider, close: () => client.close() }
}

const authOf = (call: FetchCall) => call.headers.get('authorization')

describe('T2-F10: an exported AGENTCHAT_API_KEY never silently replaces the home’s agent', () => {
  it('refuses every keyed tool with IDENTITY_CONFLICT, before any request, when the two keys differ', async () => {
    writeHomeCreds({ api_key: KEY_HOME, handle: 'sm-one' })
    vi.stubEnv('AGENTCHAT_API_KEY', KEY_ENV)
    const s = await stdio((c) => json(200, me(authOf(c) === `Bearer ${KEY_ENV}` ? 'hm-one' : 'sm-one')))
    try {
      const status = await s.call('agentchat_get_my_status')
      expect(status.isError).toBe(true)
      expect(status.text.startsWith('Error: IDENTITY_CONFLICT\n\n'), status.text).toBe(true)
      expect(status.text).toContain('@sm-one')
      expect(status.text).not.toContain(KEY_ENV)
      expect(status.text).not.toContain(KEY_HOME)
      const send = await s.call('agentchat_send_message', { to: '@peer', text: 'hi' })
      expect(send.text.startsWith('Error: IDENTITY_CONFLICT'), send.text).toBe(true)
      // Nothing went out as either agent.
      expect(s.calls).toHaveLength(0)
      expect(s.provider.status()).toMatchObject({ kind: 'conflict' })
    } finally {
      await s.close()
    }
  })

  it('the refusal lifts on the next call once the environment key is gone: no restart', async () => {
    writeHomeCreds({ api_key: KEY_HOME, handle: 'sm-one' })
    vi.stubEnv('AGENTCHAT_API_KEY', KEY_ENV)
    const s = await stdio(() => json(200, me('sm-one')))
    try {
      expect((await s.call('agentchat_get_my_status')).text).toContain('IDENTITY_CONFLICT')
      vi.stubEnv('AGENTCHAT_API_KEY', '')
      const status = await s.call('agentchat_get_my_status')
      expect(status.isError, status.text).toBe(false)
      expect(JSON.parse(status.text)).toMatchObject({ handle: 'sm-one' })
      expect(s.calls.map(authOf)).toEqual([`Bearer ${KEY_HOME}`])
    } finally {
      await s.close()
    }
  })

  it('the same key in both places is one agent and works as before', async () => {
    writeHomeCreds({ api_key: KEY_HOME, handle: 'sm-one' })
    vi.stubEnv('AGENTCHAT_API_KEY', KEY_HOME)
    const s = await stdio(() => json(200, me('sm-one')))
    try {
      const status = await s.call('agentchat_get_my_status')
      expect(status.isError, status.text).toBe(false)
      expect(s.calls.map(authOf)).toEqual([`Bearer ${KEY_HOME}`])
    } finally {
      await s.close()
    }
  })

  it('an env-only deploy (no AGENTCHAT_HOME, nothing in ~/.agentchat) still uses the environment key', async () => {
    vi.stubEnv('AGENTCHAT_HOME', '')
    vi.stubEnv('AGENTCHAT_API_KEY', KEY_ENV)
    const s = await stdio(() => json(200, me('hm-one')))
    try {
      const status = await s.call('agentchat_get_my_status')
      expect(status.isError, status.text).toBe(false)
      // (The handle lookup of an env-only deploy goes out with the same key.)
      expect(new Set(s.calls.map(authOf))).toEqual(new Set([`Bearer ${KEY_ENV}`]))
    } finally {
      await s.close()
    }
  })
})

describe('T2-F01: the stdio server’s sign-up saves the key itself and never shows it', () => {
  const verified = (call: FetchCall) => {
    if (pathOf(call) === '/v1/register/verify') return json(200, { api_key: KEY_NEW, agent: { handle: 'new-bot' } })
    if (pathOf(call) === '/v1/agents/me') return json(200, me('new-bot'))
    return json(404, { code: 'NOT_FOUND', message: `unexpected ${call.method} ${call.url}` })
  }

  it('writes the key into the home’s credentials file (owner-only) and the next call uses it', async () => {
    const s = await stdio(verified)
    try {
      const result = await s.call('agentchat_verify_otp', { pending_id: 'pnd_1', code: '123456' })
      expect(result.isError, result.text).toBe(false)
      // The key is nowhere in what the model sees.
      expect(result.text).not.toContain(KEY_NEW)
      const answer = JSON.parse(result.text) as Record<string, unknown>
      expect(answer['api_key']).toBeUndefined()
      expect(answer['store_the_key']).toBeUndefined()
      const file = path.join(home, 'credentials')
      expect(answer['key_saved_in']).toBe(file)
      expect(answer['handle']).toBe('new-bot')

      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(saved).toMatchObject({ api_key: KEY_NEW, handle: 'new-bot', api_base: API })
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        expect(fs.statSync(home).mode & 0o777).toBe(0o700)
      }
      // No leftover temp file beside it.
      expect(fs.readdirSync(home)).toEqual(['credentials'])

      const status = await s.call('agentchat_get_my_status')
      expect(status.isError, status.text).toBe(false)
      expect(authOf(s.calls[s.calls.length - 1]!)).toBe(`Bearer ${KEY_NEW}`)
    } finally {
      await s.close()
    }
  })

  it('never replaces a key the home already holds: the file stays byte for byte, and the key is handed back', async () => {
    const file = writeHomeCreds({ api_key: KEY_HOME, handle: 'sm-one' })
    const before = fs.readFileSync(file)
    const s = await stdio(verified)
    try {
      const result = await s.call('agentchat_verify_otp', { pending_id: 'pnd_1', code: '123456' })
      expect(result.isError, result.text).toBe(false)
      const answer = JSON.parse(result.text) as Record<string, unknown>
      expect(answer['api_key']).toBe(KEY_NEW)
      expect(String(answer['not_saved'])).toContain('already holds another agent’s key (@sm-one)')
      expect(answer['store_the_key']).toBeDefined()
      expect(fs.readFileSync(file).equals(before)).toBe(true)
    } finally {
      await s.close()
    }
  })

  it('saves into an empty home while the shell exports another agent’s key, and says the two now conflict', async () => {
    // AGENTCHAT_HOME names an empty home, and the shell exports another agent's key.
    vi.stubEnv('AGENTCHAT_API_KEY', KEY_ENV)
    const s = await stdio(verified)
    try {
      const result = await s.call('agentchat_verify_otp', { pending_id: 'pnd_1', code: '123456' })
      expect(result.isError, result.text).toBe(false)
      expect(result.text).not.toContain(KEY_NEW)
      expect(result.text).not.toContain(KEY_ENV)
      const answer = JSON.parse(result.text) as Record<string, unknown>
      expect(answer['key_saved_in']).toBe(path.join(home, 'credentials'))
      expect(String(answer['warning'])).toContain('IDENTITY_CONFLICT')
      // The verify call itself carried no key.
      expect(s.calls.map(authOf)).toEqual([null])
      // And the next keyed call is refused, as the warning said.
      expect((await s.call('agentchat_get_my_status')).text).toMatch(/^Error: IDENTITY_CONFLICT/)
    } finally {
      await s.close()
    }
  })

  it('the sign-up pair still works during a conflict', async () => {
    writeHomeCreds({ api_key: KEY_HOME, handle: 'sm-one' })
    vi.stubEnv('AGENTCHAT_API_KEY', KEY_ENV)
    const s = await stdio((call) =>
      pathOf(call) === '/v1/register'
        ? json(200, { pending_id: 'pnd_1', next_step: 'verify', status: 'pending', code_length: 6, message: 'We sent a code.' })
        : json(404, { code: 'NOT_FOUND', message: 'unexpected' }),
    )
    try {
      const result = await s.call('agentchat_register', { email: 'a@b.example', handle: 'new-bot' })
      expect(result.isError, result.text).toBe(false)
      expect(s.calls.map(authOf)).toEqual([null])
    } finally {
      await s.close()
    }
  })

  it('a save that throws hands the key back instead of losing it', async () => {
    const s = await stdio(verified)
    try {
      vi.spyOn(s.provider, 'saveKey').mockImplementation(() => {
        throw new Error('disk on fire')
      })
      const result = await s.call('agentchat_verify_otp', { pending_id: 'pnd_1', code: '123456' })
      expect(result.isError, result.text).toBe(false)
      const answer = JSON.parse(result.text) as Record<string, unknown>
      expect(answer['api_key']).toBe(KEY_NEW)
      expect(String(answer['not_saved'])).toContain('saving it failed (disk on fire)')
    } finally {
      vi.restoreAllMocks()
      await s.close()
    }
  })
})

describe('saveCredentials', () => {
  const source = () => ({ AGENTCHAT_HOME: home }) as NodeJS.ProcessEnv

  it('writes the CLI’s credentials shape, api_base only when it is not production', () => {
    expect(saveCredentials(source(), { apiKey: KEY_NEW, handle: '@new-bot', apiBase: 'https://api.agentchat.me/' })).toEqual({
      saved: true,
      path: path.join(home, 'credentials'),
      alreadyThere: false,
    })
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'credentials'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(saved).sort()).toEqual(['api_key', 'created_at', 'handle'])
    expect(saved['handle']).toBe('new-bot')
  })

  it('recognises the same key already saved, and refuses a different one', () => {
    writeHomeCreds({ api_key: KEY_NEW, handle: 'new-bot' })
    expect(saveCredentials(source(), { apiKey: KEY_NEW, handle: 'new-bot' })).toMatchObject({ saved: true, alreadyThere: true })
    const other = saveCredentials(source(), { apiKey: KEY_HOME, handle: 'other-bot' })
    expect(other).toMatchObject({ saved: false })
    expect(JSON.parse(fs.readFileSync(path.join(home, 'credentials'), 'utf8'))).toEqual({ api_key: KEY_NEW, handle: 'new-bot' })
  })

  it('removes a stale temp file a killed save left (it holds a key), never a fresh one or a stranger', () => {
    fs.mkdirSync(home, { recursive: true })
    const stale = path.join(home, 'credentials.123.abcdefabcdef.tmp')
    const fresh = path.join(home, 'credentials.456.0123456789ab.tmp')
    const other = path.join(home, 'credentials.backup')
    for (const f of [stale, fresh, other]) fs.writeFileSync(f, 'x')
    const old = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(stale, old, old)
    expect(saveCredentials(source(), { apiKey: KEY_NEW, handle: 'new-bot' })).toMatchObject({ saved: true })
    expect(fs.readdirSync(home).sort()).toEqual(['credentials', 'credentials.456.0123456789ab.tmp', 'credentials.backup'])
  })

  it('leaves an unreadable or malformed file alone', () => {
    const file = writeHomeCreds('not json at all')
    fs.writeFileSync(file, '{ broken')
    expect(saveCredentials(source(), { apiKey: KEY_NEW, handle: 'new-bot' })).toMatchObject({ saved: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken')
  })
})
