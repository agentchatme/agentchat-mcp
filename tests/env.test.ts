import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvValidationError, IdentityConflictError, identityHome, loadConfig, resolveIdentity } from '../src/env.js'

// Identity tests pin AGENTCHAT_HOME to an empty dir so the credentials-file
// fallback can't make the outcome depend on whether the machine running the
// suite has ever run `agentchat register`.
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-env-empty-'))
const noCreds = (source: Record<string, string>): NodeJS.ProcessEnv =>
  ({ AGENTCHAT_HOME: EMPTY_HOME, ...source }) as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('returns defaults with an empty environment', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv)
    expect(c.AGENTCHAT_API_BASE).toBe('https://api.agentchat.me')
    expect(c.AGENTCHAT_MAX_CONCURRENT_TOOLS).toBe(10)
    expect(c.AGENTCHAT_LOG_LEVEL).toBe('info')
  })

  it('does NOT require an API key — the server boots without an identity', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).not.toThrow()
  })

  it('respects a custom API base', () => {
    expect(
      loadConfig({ AGENTCHAT_API_BASE: 'https://staging.api.agentchat.me' } as NodeJS.ProcessEnv)
        .AGENTCHAT_API_BASE,
    ).toBe('https://staging.api.agentchat.me')
  })

  it('rejects a malformed API base', () => {
    expect(() => loadConfig({ AGENTCHAT_API_BASE: 'not-a-url' } as NodeJS.ProcessEnv)).toThrow(
      EnvValidationError,
    )
  })

  it('rejects an out-of-range concurrency', () => {
    expect(() => loadConfig({ AGENTCHAT_MAX_CONCURRENT_TOOLS: '0' } as NodeJS.ProcessEnv)).toThrow(
      EnvValidationError,
    )
  })

})

describe('resolveIdentity — env key', () => {
  // The env-only deploy: no AGENTCHAT_HOME, and nothing in the default home
  // (~/.agentchat). The default home is pinned to an empty folder through
  // the variables os.homedir() reads.
  const EMPTY_USER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-env-user-'))
  beforeEach(() => {
    vi.stubEnv('HOME', EMPTY_USER_HOME)
    vi.stubEnv('USERPROFILE', EMPTY_USER_HOME)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses AGENTCHAT_API_KEY when no home names an agent (an env-only deploy)', () => {
    const key = 'ac_test_'.padEnd(40, 'x')
    const id = resolveIdentity({ AGENTCHAT_API_KEY: key } as NodeJS.ProcessEnv)
    expect(id).toEqual({ apiKey: key })
    expect(identityHome({} as NodeJS.ProcessEnv)).toEqual({ home: path.join(EMPTY_USER_HOME, '.agentchat'), explicit: false })
  })

  it('refuses AGENTCHAT_API_KEY when the default home holds another agent’s key', () => {
    const home = path.join(EMPTY_USER_HOME, '.agentchat')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: 'ac_home_'.padEnd(40, 'h'), handle: 'home-bot' }))
    try {
      expect(() => resolveIdentity({ AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x') } as NodeJS.ProcessEnv)).toThrow(IdentityConflictError)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns null when there is no key and no credentials file', () => {
    expect(resolveIdentity(noCreds({}))).toBeNull()
  })

  it('treats a too-short key as absent (not a crash)', () => {
    expect(resolveIdentity(noCreds({ AGENTCHAT_API_KEY: 'short' }))).toBeNull()
  })
})
