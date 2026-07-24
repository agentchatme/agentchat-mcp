import pino from 'pino'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The IdentityProvider builds an SDK client from whatever key is on disk NOW.
// We stub the SDK constructor to record how it's called (which key, how often)
// without touching the network.

const getMeMock = vi.fn()
const ctorSpy = vi.fn()

vi.mock('agentchatme', async () => {
  const actual = await vi.importActual<typeof import('agentchatme')>('agentchatme')
  return {
    ...actual,
    AgentChatClient: vi.fn().mockImplementation((opts: unknown) => {
      ctorSpy(opts)
      return { getMe: getMeMock }
    }),
  }
})

import { IdentityProvider, NotRegisteredError } from '../src/client.js'

const config = {
  AGENTCHAT_API_BASE: 'https://api.agentchat.me',
  AGENTCHAT_MAX_CONCURRENT_TOOLS: 10,
  AGENTCHAT_LOG_LEVEL: 'silent' as const,
}
const logger = pino({ level: 'silent' })
const KEY = 'ac_live_0123456789abcdef0123456789abcdef'
const KEY2 = 'ac_live_ffffffffffffffffffffffffffffffff'

let home: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'acmcp-provider-'))
  for (const k of ['AGENTCHAT_HOME', 'AGENTCHAT_API_KEY', 'AGENTCHAT_API_BASE']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env['AGENTCHAT_HOME'] = home
  getMeMock.mockReset()
  ctorSpy.mockReset()
  getMeMock.mockResolvedValue({ handle: 'resolved-bot' })
})
afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(home, { recursive: true, force: true })
})

const writeCreds = (c: unknown): void =>
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify(c))

describe('IdentityProvider', () => {
  it('throws NotRegisteredError when there is no identity yet', () => {
    const p = new IdentityProvider(config, logger)
    expect(p.hasIdentity()).toBe(false)
    expect(() => p.getClientOrThrow()).toThrow(NotRegisteredError)
  })

  it('picks up a credentials file written AFTER construction — no restart', () => {
    const p = new IdentityProvider(config, logger)
    expect(() => p.getClientOrThrow()).toThrow(NotRegisteredError)

    writeCreds({ api_key: KEY, handle: 'me-bot' }) // ← `agentchat register` mid-session
    expect(p.getClientOrThrow()).toBeDefined() // resolved on the very next call
    expect(p.getSelfHandle()).toBe('me-bot') // handle from the file — no getMe
    expect(ctorSpy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: KEY }))
  })

  it('rebuilds only when the key changes (register/login/recover), not per call', () => {
    writeCreds({ api_key: KEY, handle: 'me-bot' })
    const p = new IdentityProvider(config, logger)
    p.getClientOrThrow()
    p.getClientOrThrow() // same key
    expect(ctorSpy).toHaveBeenCalledTimes(1)

    writeCreds({ api_key: KEY2, handle: 'me-bot' }) // ← recover / re-key
    p.getClientOrThrow()
    expect(ctorSpy).toHaveBeenCalledTimes(2)
    expect(ctorSpy).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: KEY2 }))
  })
})
