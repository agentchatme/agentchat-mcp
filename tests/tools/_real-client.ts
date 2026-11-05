import { AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { NotAuthenticatedError, NotRegisteredError } from '../../src/client.js'
import { Semaphore } from '../../src/semaphore.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Test context with a REAL SDK client over a stubbed network ────────────
//
// The Phase 4 tools call the pinned SDK client. Stubbing the client's methods
// with vi.fn() would only prove the handler called a method; stubbing fetch
// under a real client proves the whole chain a host depends on — the exact
// URL, method and body on the wire, and the real error pipeline (status →
// typed SDK error → tool guidance → mapped tool error).

export type FetchCall = {
  url: string
  method: string
  headers: Headers
  /** JSON-parsed when the body was a string; the raw bytes otherwise. */
  body: unknown
  rawBody: unknown
}

export function fetchStub(
  respond: (call: FetchCall, index: number) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = init?.body
    let body: unknown = null
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const call: FetchCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      rawBody: raw ?? null,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as typeof fetch
  return { impl, calls }
}

export function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export const KEY = 'ac_live_0123456789abcdef0123456789abcdef'
export const API_BASE = 'https://api.agentchat.test'

export interface RealCtxOptions {
  apiKey?: string | null
  mode?: 'stdio' | 'hosted'
  selfHandle?: string
}

/** A ToolContext whose `client` is a real AgentChatClient bound to `fetchImpl`, retries off. */
export function makeRealCtx(fetchImpl: typeof fetch, options: RealCtxOptions = {}): ToolContext {
  const apiKey = options.apiKey === undefined ? KEY : options.apiKey
  const mode = options.mode ?? 'stdio'
  const client =
    apiKey === null
      ? null
      : new AgentChatClient({
          apiKey,
          baseUrl: API_BASE,
          fetch: fetchImpl,
          retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
        })
  return {
    get client(): AgentChatClient {
      if (client === null) {
        throw mode === 'hosted' ? new NotAuthenticatedError() : new NotRegisteredError()
      }
      return client
    },
    logger: pino({ level: 'silent' }),
    selfHandle: options.selfHandle ?? '@me',
    semaphore: new Semaphore(10),
    inflight: new Set(),
    rest: { apiBase: API_BASE, apiKey, fetchImpl },
    turnKey: () => undefined,
    mode,
  }
}

export function firstText(result: { content: unknown[] }): string {
  return (result.content as Array<{ text: string }>)[0]!.text
}

export function payloadOf(result: { content: unknown[] }): Record<string, unknown> {
  return JSON.parse(firstText(result)) as Record<string, unknown>
}

export function pathOf(call: FetchCall): string {
  const url = new URL(call.url)
  return url.pathname + url.search
}
