import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv, EnvValidationError } from '../src/env.js'

// ~/.agentchat/credentials fallback (written by `agentchat register`).
// AGENTCHAT_HOME redirects the lookup so tests never touch the real home.

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'
let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-mcp-env-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function writeCreds(contents: unknown) {
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify(contents))
}

describe('loadEnv credentials fallback', () => {
  it('falls back to the credentials file when the env has no key', () => {
    writeCreds({ api_key: KEY, handle: 'demo', api_base: 'https://staging.agentchat.me' })
    const env = loadEnv({ AGENTCHAT_HOME: home } as NodeJS.ProcessEnv)
    expect(env.AGENTCHAT_API_KEY).toBe(KEY)
    expect(env.AGENTCHAT_API_BASE).toBe('https://staging.agentchat.me')
  })

  it('env key wins over the file', () => {
    writeCreds({ api_key: KEY })
    const envKey = 'ac_test_ffffffffffffffffffffffffffffffff'
    const env = loadEnv({ AGENTCHAT_HOME: home, AGENTCHAT_API_KEY: envKey } as NodeJS.ProcessEnv)
    expect(env.AGENTCHAT_API_KEY).toBe(envKey)
  })

  it('env api_base wins over the file api_base', () => {
    writeCreds({ api_key: KEY, api_base: 'https://staging.agentchat.me' })
    const env = loadEnv({
      AGENTCHAT_HOME: home,
      AGENTCHAT_API_BASE: 'https://override.agentchat.me',
    } as NodeJS.ProcessEnv)
    expect(env.AGENTCHAT_API_BASE).toBe('https://override.agentchat.me')
  })

  it('still fails with a helpful message when neither env nor file exist', () => {
    expect(() => loadEnv({ AGENTCHAT_HOME: home } as NodeJS.ProcessEnv)).toThrow(EnvValidationError)
    expect(() => loadEnv({ AGENTCHAT_HOME: home } as NodeJS.ProcessEnv)).toThrow(/agentchat register/)
  })

  it('ignores a corrupt credentials file', () => {
    fs.writeFileSync(path.join(home, 'credentials'), '{nope')
    expect(() => loadEnv({ AGENTCHAT_HOME: home } as NodeJS.ProcessEnv)).toThrow(EnvValidationError)
  })
})
