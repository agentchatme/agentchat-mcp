import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdentityConflictError, resolveIdentity } from '../src/env.js'

// The credentials file (written by `agentchat register` / `login`). This is
// the identity path the coding-agent plugins use (they pass AGENTCHAT_HOME, not
// AGENTCHAT_API_KEY). resolveIdentity RE-READS it every call — that's what
// removed the "restart your session" step.

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'
const KEY2 = 'ac_live_ffffffffffffffffffffffffffffffff'
let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-mcp-env-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const writeCreds = (contents: unknown): void =>
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify(contents))
const src = (): NodeJS.ProcessEnv => ({ AGENTCHAT_HOME: home }) as NodeJS.ProcessEnv

describe('resolveIdentity — credentials file', () => {
  it('reads api_key, api_base, and handle', () => {
    writeCreds({ api_key: KEY, api_base: 'https://x.example', handle: 'me-bot' })
    const id = resolveIdentity(src())
    expect(id?.apiKey).toBe(KEY)
    expect(id?.apiBase).toBe('https://x.example')
    expect(id?.handle).toBe('me-bot')
  })

  // Lab round 1, T2-F10: a stdio entry whose AGENTCHAT_HOME holds one agent
  // silently acted as another when the shell exported AGENTCHAT_API_KEY for
  // it. The environment's key no longer replaces the home's: it is refused.
  it('an exported AGENTCHAT_API_KEY that is not the home’s key is refused, never used', () => {
    writeCreds({ api_key: KEY, handle: 'home-bot' })
    const source = { AGENTCHAT_HOME: home, AGENTCHAT_API_KEY: KEY2 } as NodeJS.ProcessEnv
    expect(() => resolveIdentity(source)).toThrow(IdentityConflictError)
    try {
      resolveIdentity(source)
    } catch (err) {
      const conflict = err as IdentityConflictError
      expect(conflict.code).toBe('IDENTITY_CONFLICT')
      // Plain: which file, which agent, the two ways out — and never a key.
      expect(conflict.message).toContain(path.join(home, 'credentials'))
      expect(conflict.message).toContain('@home-bot')
      expect(conflict.message).toContain('remove AGENTCHAT_API_KEY')
      expect(conflict.message).toContain('`agentchat login --api-key -`')
      expect(conflict.message).not.toContain(KEY)
      expect(conflict.message).not.toContain(KEY2)
    }
  })

  it('the same key in the environment and the home is that one identity, with the home’s handle', () => {
    writeCreds({ api_key: KEY, handle: 'home-bot', api_base: 'https://x.example' })
    const id = resolveIdentity({ AGENTCHAT_HOME: home, AGENTCHAT_API_KEY: `  ${KEY}\n` } as NodeJS.ProcessEnv)
    expect(id).toEqual({ apiKey: KEY, apiBase: 'https://x.example', handle: 'home-bot' })
  })

  it('a home without a key takes the environment’s key (an env-only deploy, as agent-core does)', () => {
    const id = resolveIdentity({ AGENTCHAT_HOME: home, AGENTCHAT_API_KEY: KEY2 } as NodeJS.ProcessEnv)
    expect(id).toEqual({ apiKey: KEY2 })
  })

  it('returns null when the file is absent', () => {
    expect(resolveIdentity(src())).toBeNull()
  })

  it('returns null for a file whose key is too short', () => {
    writeCreds({ api_key: 'short' })
    expect(resolveIdentity(src())).toBeNull()
  })

  // THE FIX: each call re-reads the file, so a register/login that happens
  // AFTER the server started is picked up on the very next tool call.
  it('re-reads every call — a newly written key is seen with no restart', () => {
    expect(resolveIdentity(src())).toBeNull() // fresh install: no identity yet
    writeCreds({ api_key: KEY, handle: 'me-bot' }) // ← `agentchat register` mid-session
    expect(resolveIdentity(src())?.apiKey).toBe(KEY) // seen immediately
    writeCreds({ api_key: KEY2, handle: 'me-bot' }) // ← a re-key (recover)
    expect(resolveIdentity(src())?.apiKey).toBe(KEY2) // also seen immediately
  })
})
