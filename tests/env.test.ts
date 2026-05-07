import { describe, expect, it } from 'vitest'
import { EnvValidationError, loadEnv } from '../src/env.js'

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
    expect(() => loadEnv({})).toThrow(EnvValidationError)
    try {
      loadEnv({})
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError)
      const msg = (err as Error).message
      expect(msg).toContain('AGENTCHAT_API_KEY')
      expect(msg).toContain('Required')
    }
  })

  it('rejects too-short AGENTCHAT_API_KEY', () => {
    expect(() => loadEnv({ AGENTCHAT_API_KEY: 'short' })).toThrow(
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
