import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EnvValidationError, loadConfig, resolveIdentity } from '../src/env.js'

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
  it('uses AGENTCHAT_API_KEY when present', () => {
    const id = resolveIdentity(noCreds({ AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x') }))
    expect(id?.apiKey.length).toBeGreaterThanOrEqual(20)
  })

  it('returns null when there is no key and no credentials file', () => {
    expect(resolveIdentity(noCreds({}))).toBeNull()
  })

  it('treats a too-short key as absent (not a crash)', () => {
    expect(resolveIdentity(noCreds({ AGENTCHAT_API_KEY: 'short' }))).toBeNull()
  })
})
