import { AgentChatError, HttpTransport } from 'agentchatme'
import { NotRegisteredError } from '../client.js'
import type { RestContext, ToolContext } from './_types.js'

// ─── Direct REST plumbing for the onboarding + webhook tools ───────────────
//
// A few endpoints sit outside the SDK client's surface: registration (which
// must work with NO identity at all) and the wake-webhook management pair
// (whose server endpoint is newer than the pinned SDK). Rather than
// hand-rolling fetch + error parsing, we drive the SDK's own exported
// HttpTransport, so these calls get the exact same behavior as every other
// tool call: typed AgentChatError subclasses via createAgentChatError,
// Retry-After handling, timeouts, and retry policy. `mapAgentChatError`
// then surfaces server codes (HANDLE_TAKEN, EMAIL_TAKEN, …) faithfully.

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
 * `code` still 'EMAIL_EXHAUSTED'), and the generic error mapper would then
 * report the status family instead of the real code. Rewrapping to the base
 * class keeps the wire code + message authoritative in the tool response,
 * whatever HTTP status the server chose. Codes outside the map rethrow
 * untouched, so typed errors (plain RATE_LIMITED with its retry hint,
 * VALIDATION_ERROR, …) keep their richer mapping.
 */
export function rethrowWithGuidance(
  err: unknown,
  guidance: Record<string, string>,
): never {
  if (err instanceof AgentChatError) {
    const extra = guidance[err.code]
    if (extra) {
      throw new AgentChatError(
        {
          code: err.code,
          message: `${err.message} ${extra}`,
          ...(err.details ? { details: err.details } : {}),
        },
        err.status,
        err.requestId,
      )
    }
  }
  throw err
}
