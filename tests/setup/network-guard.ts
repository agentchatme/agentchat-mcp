import * as net from 'node:net'
import { afterEach } from 'vitest'

// ─── No test reaches the network ────────────────────────────────────────────
//
// Loaded before every test file (vitest.config.ts → setupFiles). Any fetch
// or socket connection to a host that is not loopback is refused, AND the
// test that tried fails in afterEach even if it swallowed the error — a test
// that expected "some error" must not pass by having reached a real server.
// Stub the network at the tool's fetchImpl (or vi.stubGlobal('fetch', …))
// and use a `.test` / `.invalid` base URL instead.
//
// Covered: globalThis.fetch (also what the SDK captures when a client is
// built without its own fetch), and net.Socket#connect — which net.connect,
// tls.connect and the http/https agents all go through. Loopback hosts and
// IPC paths stay open (a test may run a local server).

export class NetworkBlockedError extends Error {
  constructor(target: string) {
    super(`network-guard: blocked a connection to ${target} — tests must stub the network (fetchImpl / vi.stubGlobal) and use a .test base URL`)
    this.name = 'NetworkBlockedError'
  }
}

const blocked: string[] = []

/** Drain the attempts recorded so far — for the guard's own tests only. */
export function takeBlockedAttempts(): string[] {
  return blocked.splice(0, blocked.length)
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('127.')
}

function refuse(target: string): NetworkBlockedError {
  blocked.push(target)
  return new NetworkBlockedError(target)
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const raw = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input)
  let host: string
  try {
    host = new URL(raw).hostname
  } catch {
    return realFetch(input, init) // not an absolute URL: fetch rejects it itself
  }
  if (!isLoopbackHost(host)) throw refuse(raw)
  return realFetch(input, init)
}) as typeof fetch

/** The host a Socket#connect call targets, or null for an IPC path. */
function connectHost(args: unknown[]): string | null {
  // net.connect() hands Socket#connect its normalized [options, callback].
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]
  if (typeof first === 'string') return null
  if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost'
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: unknown; host?: unknown }
    if (typeof options.path === 'string') return null
    return typeof options.host === 'string' ? options.host : 'localhost'
  }
  return null
}

const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const host = connectHost(args)
  if (host !== null && !isLoopbackHost(host)) throw refuse(`socket ${host}`)
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args)
} as typeof realConnect

afterEach(() => {
  const attempts = takeBlockedAttempts()
  if (attempts.length > 0) {
    throw new Error(`network-guard: this test tried to reach the network: ${attempts.join(', ')}`)
  }
})
