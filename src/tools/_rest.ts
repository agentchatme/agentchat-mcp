import { AgentChatClient, AgentChatError, type RequestHooks, type RetryPolicy } from 'agentchatme'
import { NotRegisteredError } from '../client.js'
import { attachToolGuidance, joinSentences } from '../errors.js'
import type { ToolContext } from './_types.js'

// ─── Every server call goes through the SDK ────────────────────────────────
//
// Each tool reaches the server through an agentchatme SDK method, never a
// hand-built request: the receive engine (the tray, verdicts, mark-read, the
// long-poll body pull and its delivery ack), invite dismiss, the wake
// webhook (set, test, clear), and the two sign-up calls (the SDK's static
// `register` / `verify`, which work with no identity at all). One
// implementation of each wire for every integration, this tool core
// included, and the same typed AgentChatError subclasses, Retry-After
// handling and timeouts everywhere; `mapAgentChatError` then surfaces server
// codes (HANDLE_TAKEN, EMAIL_LIMIT_REACHED, …) faithfully.
//
// A tool builds its client per call with `engineClient`, bound to the same
// identity and fetch as `ctx.client` (so the same product-identity headers),
// with the retry policy that tool chose: a long-poll gets one attempt (a
// retry would park again past the host's deadline), a keyed write a couple of
// quick retries, the wake-webhook calls the SDK's default. The policy then
// does not depend on how the composition built `ctx.client`. Building a
// client is synchronous and does no I/O.

/** One attempt only: long-polls, whose retry would park again past the deadline. */
export const NO_RETRY: RetryPolicy = Object.freeze({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 })

/**
 * An SDK client for the session's identity with `retry` as its policy. The
 * policy applies only to calls the transport may retry at all (GET, PUT,
 * DELETE, or a POST that carries an Idempotency-Key); a POST without a key
 * is never retried, whatever the policy. A call may still narrow it with its
 * own `retry` option (a long-poll passes `'never'`). `hooks` are the SDK's
 * observability hooks (e.g. agentchat_decide watches for a 2xx it can trust
 * even when the body is unreadable).
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

function isJsonNull(text: string): boolean {
  try {
    return JSON.parse(text) === null
  } catch {
    return false
  }
}

/**
 * A fetch that remembers whether the server's last answer was a 2xx with an
 * empty or JSON-null body, for the calls below that must tell "the server
 * answered, with nothing to read" apart from a failure (see
 * `isUnreadAnswer`). Works for the client and for the SDK's static calls
 * alike, which take a `fetch` but no hooks. Within one SDK call the last
 * answer is the one that ended it: the transport stops at the first 2xx.
 *
 * It never reads the body itself: a 2xx body is handed to the transport
 * through a pass-through stream that sees the text as the transport reads
 * it, and decides once the body has ended — before the SDK looks inside it.
 * The bytes, the timing (the read is outside the request timeout, as
 * before) and every read failure (a connection cut mid-body rejects with
 * its own error, and an unfinished body is never counted as empty) stay
 * exactly what they were. Other statuses pass through untouched.
 */
export function watchAnswers(
  fetchImpl: typeof fetch,
): { fetch: typeof fetch; answeredEmpty: () => boolean } {
  let answeredEmpty = false
  const watched = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    answeredEmpty = false
    const res = await fetchImpl(input, init)
    if (res.status < 200 || res.status >= 300) return res
    if (res.body === null) {
      answeredEmpty = true // 204, or a 2xx built without a body
      return res
    }
    const decoder = new TextDecoder()
    let text = ''
    const seeing = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        text += decoder.decode(chunk, { stream: true })
        controller.enqueue(chunk)
      },
      flush() {
        text += decoder.decode()
        answeredEmpty = text === '' || isJsonNull(text)
      },
    })
    return new Response(res.body.pipeThrough(seeing), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }) as typeof fetch
  return { fetch: watched, answeredEmpty: () => answeredEmpty }
}

/**
 * Did this SDK call fail only because the SDK could not read a 2xx body?
 * Some SDK methods read one field off the body unguarded
 * (`wakeWebhook.set` → `wake_webhook`, `wakeWebhook.test` → `test_wake`,
 * static `verify` → `api_key`), so a 2xx whose body is empty or JSON null
 * makes that read throw a TypeError although the server answered. That is
 * exactly this case: the last answer was such a 2xx (watchAnswers saw the
 * body) and the error is a TypeError. Every failure keeps failing: an HTTP
 * error (AgentChatError), a connection failure, timeout or a 2xx body that
 * is not JSON (the SDK's ConnectionError), an abort (AbortError), a body
 * cut mid-read (its own error, as before). The caller treats the body as
 * absent, exactly as reading it by hand did.
 */
export function isUnreadAnswer(err: unknown, answeredEmpty: boolean): boolean {
  return answeredEmpty && err instanceof TypeError
}

/**
 * Append actionable guidance to a server error for the codes a tool knows
 * how to advise on, preserving the server's code and message (as its own
 * sentence: a period is added where the server's message has none). The
 * server's message is also recorded as it came, for the codes whose message
 * the mapper rebuilds. Always throws.
 *
 * Matching is by the SERVER's error code, not the SDK class: the SDK's
 * createAgentChatError falls back to a status-based class for codes it does
 * not know (e.g. a 429 OTP_COOLDOWN arrives as RateLimitedError with
 * `code` still 'OTP_COOLDOWN').
 *
 * The guidance is appended to the ORIGINAL error object's message in place —
 * never re-minted onto a fresh base AgentChatError — so the subclass and all
 * its extras survive: class identity, `retryAfterMs` on RateLimitedError,
 * `status`, `requestId`, `details`. (The old rewrap discarded the subclass,
 * so a guided 429 lost its Retry-After hint in the mapped tool error.) errors.ts keeps the wire code + message authoritative for
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
      attachToolGuidance(err, extra, { wireMessage: err.message })
      err.message = joinSentences(err.message, extra)
    }
  }
  throw err
}
