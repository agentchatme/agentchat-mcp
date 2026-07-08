import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EnvValidationError, loadEnv } from '../src/env.js'

// Negative tests must pin AGENTCHAT_HOME to an empty directory — otherwise
// the ~/.agentchat/credentials fallback makes their outcome depend on
// whether the machine running the suite has ever run `agentchat register`
// (which would break prepublishOnly on exactly the machines this release
// targets).
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-env-empty-'))
const noCreds = (source: Record<string, string>) =>
  ({ AGENTCHAT_HOME: EMPTY_HOME, ...source }) as NodeJS.ProcessEnv

describe('loadEnv', () => {
  it('returns parsed defaults when only AGENTCHAT_API_KEY is set', () => {
    const env = loadEnv({ AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x') })
    expect(env.AGENTCHAT_API_KEY.length).toBeGreaterThanOrEqual(20)
    expect(env.AGENTCHAT_API_BASE).toBe('https://api.agentchat.me')
    expect(env.AGENTCHAT_MAX_CONCURRENT_TOOLS).toBe(10)
    expect(env.AGENTCHAT_LOG_LEVEL).toBe('info')
  })

  it('respects custom AGENTCHAT_API_BASE', () => {
    const env = loadEnv({
      AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x'),
      AGENTCHAT_API_BASE: 'https://staging.api.agentchat.me',
    })
    expect(env.AGENTCHAT_API_BASE).toBe('https://staging.api.agentchat.me')
  })

  it('coerces AGENTCHAT_MAX_CONCURRENT_TOOLS from string', () => {
    const env = loadEnv({
      AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x'),
      AGENTCHAT_MAX_CONCURRENT_TOOLS: '25',
    })
    expect(env.AGENTCHAT_MAX_CONCURRENT_TOOLS).toBe(25)
  })

  it('rejects missing AGENTCHAT_API_KEY with a human-readable message', () => {
    expect(() => loadEnv(noCreds({}))).toThrow(EnvValidationError)
    try {
      loadEnv(noCreds({}))
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError)
      const msg = (err as Error).message
      expect(msg).toContain('AGENTCHAT_API_KEY')
      expect(msg).toContain('Required')
    }
  })

  it('rejects too-short AGENTCHAT_API_KEY', () => {
    expect(() => loadEnv(noCreds({ AGENTCHAT_API_KEY: 'short' }))).toThrow(
      EnvValidationError,
    )
  })

  it('rejects invalid AGENTCHAT_API_BASE URL', () => {
    expect(() =>
      loadEnv({
        AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x'),
        AGENTCHAT_API_BASE: 'not-a-url',
      }),
    ).toThrow(EnvValidationError)
  })

  it('rejects invalid AGENTCHAT_LOG_LEVEL', () => {
    expect(() =>
      loadEnv({
        AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x'),
        AGENTCHAT_LOG_LEVEL: 'verbose',
      }),
    ).toThrow(EnvValidationError)
  })
})
