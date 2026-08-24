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
    AgentChatClient: class AgentChatClientMock {
      readonly getMe = getMeMock

      constructor(opts: unknown) {
        ctorSpy(opts)
      }
    },
  }
})

import {
  FixedIdentityProvider,
  IdentityProvider,
  NotRegisteredError,
} from '../src/client.js'
import { withMcpClientIdentity } from '../src/client-identity.js'
import { PACKAGE_VERSION } from '../src/version.js'

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
  vi.unstubAllGlobals()
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

  it('rebuilds only when the identity endpoint changes, not per call', () => {
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

  it('rebuilds when the same key moves to a different API base', () => {
    writeCreds({
      api_key: KEY,
      api_base: 'https://first.example.test',
      handle: 'me-bot',
    })
    const p = new IdentityProvider(config, logger)
    p.getClientOrThrow()
    expect(ctorSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: 'https://first.example.test' }),
    )

    writeCreds({
      api_key: KEY,
      api_base: 'https://second.example.test',
      handle: 'me-bot',
    })
    p.getClientOrThrow()
    expect(ctorSpy).toHaveBeenCalledTimes(2)
    expect(ctorSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: 'https://second.example.test' }),
    )
  })
})

describe('IdentityProvider — late fetch binding', () => {
  it('resolves the base fetch at client-build time, so a global patch after construction is honored on the first call', async () => {
    writeCreds({ api_key: KEY, handle: 'me-bot' })
    const p = new IdentityProvider(config, logger) // constructed BEFORE the patch

    const seen: string[] = []
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input))
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    p.getClientOrThrow() // first client build happens NOW, after the patch
    const clientOpts = ctorSpy.mock.calls.at(-1)![0] as { fetch: typeof fetch }
    await clientOpts.fetch('https://api.agentchat.me/v1/ping')
    expect(seen).toEqual(['https://api.agentchat.me/v1/ping'])

    // The raw REST view resolves per-read, so an even later patch wins too.
    const seenLater: string[] = []
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0]) => {
      seenLater.push(String(input))
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)
    await p.getRest().fetchImpl('https://api.agentchat.me/v1/register')
    expect(seenLater).toEqual(['https://api.agentchat.me/v1/register'])
    expect(seen).toHaveLength(1)
  })
})

describe('FixedIdentityProvider — selfHandle', () => {
  const FIXED = {
    apiBase: 'https://api.agentchat.me',
    apiKey: KEY,
    fetchImpl: globalThis.fetch,
  }

  it('returns a provided selfHandle immediately and never fires the background getMe', async () => {
    const p = new FixedIdentityProvider({ ...FIXED, selfHandle: '@fixed-bot' })
    expect(p.getSelfHandle()).toBe('@fixed-bot')
    await new Promise((resolve) => setImmediate(resolve))
    expect(p.getSelfHandle()).toBe('@fixed-bot')
    expect(getMeMock).not.toHaveBeenCalled()
  })

  it('lazy path: a failed handle fetch is retried on the next ask instead of latching "?" forever', async () => {
    getMeMock.mockReset()
    getMeMock
      .mockRejectedValueOnce(new Error('transient boom'))
      .mockResolvedValueOnce({ handle: 'late-bot' })

    const p = new FixedIdentityProvider({ ...FIXED })
    expect(p.getSelfHandle()).toBe('?') // ask #1 starts fetch #1
    expect(getMeMock).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setImmediate(resolve)) // rejection settles; flag resets

    expect(p.getSelfHandle()).toBe('?') // ask #2 starts fetch #2 (the retry)
    expect(getMeMock).toHaveBeenCalledTimes(2)
    await new Promise((resolve) => setImmediate(resolve)) // success settles

    expect(p.getSelfHandle()).toBe('late-bot')
    expect(getMeMock).toHaveBeenCalledTimes(2) // resolved handle stops further fetches
  })
})

describe('MCP client identity', () => {
  it('attaches stable MCP name and version headers', async () => {
    const seen = new Headers()
    const fetchImpl = async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      new Headers(init?.headers).forEach((value, key) => seen.set(key, value))
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    await withMcpClientIdentity(fetchImpl as typeof fetch)(
      'https://api.agentchat.me/v1/messages/sync',
    )

    expect(seen.get('x-agentchat-client')).toBe('mcp')
    expect(seen.get('x-agentchat-client-version')).toBe(PACKAGE_VERSION)
  })
})
