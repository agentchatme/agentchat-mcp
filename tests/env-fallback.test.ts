import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveIdentity } from '../src/env.js'

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

  it('env key wins over the file', () => {
    writeCreds({ api_key: KEY })
    const id = resolveIdentity({ AGENTCHAT_HOME: home, AGENTCHAT_API_KEY: KEY2 } as NodeJS.ProcessEnv)
    expect(id?.apiKey).toBe(KEY2)
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
