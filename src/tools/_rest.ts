import {
  AgentChatClient,
  AgentChatError,
  HttpTransport,
  type RequestHooks,
  type RetryPolicy,
} from 'agentchatme'
import { NotRegisteredError } from '../client.js'
import { attachToolGuidance } from '../errors.js'
import type { RestContext, ToolContext } from './_types.js'

// ─── Direct REST plumbing for the onboarding + webhook tools ───────────────
//
// A few endpoints sit outside the SDK client's surface: registration (which
// must work with NO identity at all), the wake-webhook endpoints, the
// long-poll body pull (/v1/messages/sync?wait_ms), the tray read (it sends
// `invites=1`, which `inbox.tray` cannot add yet) and the invite dismiss —
// each newer than, or shaped beyond, the pinned SDK's methods. Rather than
// hand-rolling fetch + error parsing, we drive the SDK's own exported
// HttpTransport, so these calls get the exact same behavior as every other
// tool call: typed AgentChatError subclasses via createAgentChatError,
// Retry-After handling, timeouts, and retry policy. `mapAgentChatError`
// then surfaces server codes (HANDLE_TAKEN, EMAIL_TAKEN, …) faithfully.
//
// ─── The engine calls go through the SDK client ───────────────────────────
//
// The receive engine — verdicts, mark-read, the delivery ack — is the
// SDK's (`decisions.record`, `conversations.markRead`, `syncAck`): one
// implementation of those wires for every integration, this tool core
// included. (The tray read is back on the transport until `inbox.tray` can
// send the `invites=1` opt-in; see tools/inbox.ts.) Each engine tool builds its client per call with
// `engineClient`, bound to the same identity and fetch as `ctx.client`, for
// one reason: the retry policy. The SDK's per-call options carry signal,
// timeout and idempotency key but no retry override, and the shared client's
// default (3 retries, up to 8 s apart) would re-park a long-poll past the
// host's deadline or stretch a 10 s write past a 30 s tool budget. Building
// a client is synchronous and does no I/O.

/** One attempt only: long-polls, whose retry would park again past the deadline. */
export const NO_RETRY: RetryPolicy = Object.freeze({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 })

/**
 * An SDK client for the session's identity with `retry` as its policy. The
 * policy applies only to calls the transport may retry at all (GET, or a
 * POST that carries an Idempotency-Key); a POST without a key is never
 * retried, whatever the policy. `hooks` are the SDK's observability hooks
 * (e.g. agentchat_decide watches for a 2xx it can trust even when the body
 * is unreadable).
 */
export function engineClient(
  rest: AuthenticatedRest,
  retry: RetryPolicy,
  hooks?: RequestHooks,
): AgentChatClient {
  return new AgentChatClient({
    apiKey: rest.apiKey,
    baseUrl: rest.apiBase,
    fetch: rest.fetchImpl,
    retry,
    ...(hooks ? { hooks } : {}),
  })
}

/** Transport bound to the session's base URL and (optionally) its key. */
export function restTransport(
  rest: Pick<RestContext, 'apiBase' | 'fetchImpl'> & { apiKey?: string | null },
  options: { withAuth: boolean },
): HttpTransport {
  return new HttpTransport({
    baseUrl: rest.apiBase,
    fetch: rest.fetchImpl,
    ...(options.withAuth && rest.apiKey ? { apiKey: rest.apiKey } : {}),
  })
}

export interface AuthenticatedRest {
  apiBase: string
  apiKey: string
  fetchImpl: typeof fetch
}

/**
 * Resolve the session's REST identity, requiring a key. When there is none,
 * surface the COMPOSITION's canonical unauthenticated error by touching
 * `ctx.client` — NotRegisteredError on stdio ("run `agentchat register`"),
 * NotAuthenticatedError on the hosted core ("send Authorization: Bearer…").
 * On stdio an identity can also appear between the two reads (mid-session
 * `agentchat login`), in which case the fresh re-read simply succeeds.
 */
export function requireRestAuth(ctx: ToolContext): AuthenticatedRest {
  let rest = ctx.rest
  if (rest.apiKey === null) {
    void ctx.client // throws the composition's unauthenticated error…
    rest = ctx.rest // …or an identity appeared mid-session; re-read it
  }
  const { apiBase, apiKey, fetchImpl } = rest
  if (apiKey === null) {
    // Unreachable in practice (ctx.client above throws first); keeps this
    // function total without a non-null assertion.
    throw new NotRegisteredError()
  }
  return { apiBase, apiKey, fetchImpl }
}

/**
 * Append actionable guidance to a server error for the codes a tool knows
 * how to advise on, preserving the server's code and message. Always throws.
 *
 * Matching is by the SERVER's error code, not the SDK class: the SDK's
 * createAgentChatError falls back to a status-based class for codes it does
 * not know (e.g. a 429 EMAIL_EXHAUSTED arrives as RateLimitedError with
 * `code` still 'EMAIL_EXHAUSTED').
 *
 * The guidance is appended to the ORIGINAL error object's message in place —
 * never re-minted onto a fresh base AgentChatError — so the subclass and all
 * its extras survive: class identity, `retryAfterMs` on RateLimitedError,
 * `status`, `requestId`, `details`. (The old rewrap discarded the subclass,
 * so a guided EMAIL_EXHAUSTED lost its Retry-After hint in the mapped tool
 * error.) errors.ts keeps the wire code + message authoritative for
 * status-fallback-minted subclasses. Codes outside the map rethrow
 * untouched, so typed errors (plain RATE_LIMITED with its retry hint,
 * VALIDATION_ERROR, …) keep their richer mapping. For plain RATE_LIMITED the
 * mapper rebuilds the message, so the guidance is ALSO recorded out of band
 * (attachToolGuidance) and the mapper uses it in place of its generic text —
 * a 429 from the test-wake cap or the inbox poll is explained as such.
 */
export function rethrowWithGuidance(
  err: unknown,
  guidance: Record<string, string>,
): never {
  if (err instanceof AgentChatError) {
    const extra = guidance[err.code]
    if (extra) {
      err.message = `${err.message} ${extra}`
      attachToolGuidance(err, extra)
    }
  }
  throw err
}
