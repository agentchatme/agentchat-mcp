import {
  AgentChatError,
  AwaitingReplyError,
  BlockedError,
  ConnectionError,
  ForbiddenError,
  GroupDeletedError,
  NotFoundError,
  RateLimitedError,
  RecipientBackloggedError,
  RestrictedError,
  ServerError,
  SuspendedError,
  UnauthorizedError,
  ValidationError,
} from 'agentchatme'
import { NotAuthenticatedError, NotRegisteredError } from './client.js'
import type { ServerMode } from './instructions.js'

// ─── Tool-attached guidance ────────────────────────────────────────────────
//
// A tool that knows WHICH limit or rule it hit appends endpoint-specific
// guidance to the server error (tools/_rest.ts rethrowWithGuidance). For codes
// whose message the mapper rebuilds from scratch (plain RATE_LIMITED) the
// appended text would be lost, so the same guidance is also recorded out of
// band on the error object and the mapper prefers it over its generic text.
//
// `replace: true` marks guidance that is the WHOLE answer: the mapper then
// drops its generic sentence for that class (today: the not-found text) and
// says only what the tool knows — e.g. a dismiss on a server that has no
// dismiss endpoint is not "the resource does not exist".
const TOOL_GUIDANCE = Symbol.for('@agentchatme/mcp.toolGuidance')
const TOOL_GUIDANCE_REPLACES = Symbol.for('@agentchatme/mcp.toolGuidanceReplaces')
type Guided = { [TOOL_GUIDANCE]?: string; [TOOL_GUIDANCE_REPLACES]?: boolean }

/** Record the endpoint-specific guidance a tool attached to a server error. */
export function attachToolGuidance(
  err: object,
  guidance: string,
  options: { replace?: boolean } = {},
): void {
  ;(err as Guided)[TOOL_GUIDANCE] = guidance
  if (options.replace) (err as Guided)[TOOL_GUIDANCE_REPLACES] = true
}

/** The guidance a tool attached via attachToolGuidance, if any. */
export function toolGuidanceOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as Guided)[TOOL_GUIDANCE] : undefined
}

/** True when the attached guidance replaces the mapper's generic text. */
function toolGuidanceReplaces(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Guided)[TOOL_GUIDANCE_REPLACES] === true
}

// What a 429 means depends on the endpoint — the send path, the inbox long-
// poll, the test-wake cap and registration all have their own limits — so
// the specific advice comes from the calling tool. This is the fallback for
// tools that attached none.
const RATE_LIMITED_FALLBACK_GUIDANCE =
  'Per-agent rate limits are shared across all your tool calls (sends are capped at 60 messages/second); honor the retry hint before calling again.'

// ─── AgentChat → MCP error mapping ─────────────────────────────────────────
//
// AgentChat's SDK throws structured, typed errors. The MCP host can only
// surface tool failures back to the LLM as text — there is no out-of-band
// error channel — so the agent reading the failure needs an actionable
// message, not a stack trace. This module normalises every known SDK error
// shape into a single `MappedError` carrying:
//   - a short `code` (UPPER_SNAKE) the LLM can branch on
//   - a human-readable `message` it can echo or paraphrase
//   - an optional `retryAfterSeconds` hint when the underlying call is
//     bounded by rate-limiting
//
// Unknown errors fall through to a generic `INTERNAL_ERROR` shape so a
// future SDK error class doesn't crash the server — it just downgrades the
// LLM's branching information.

export interface MappedError {
  code: string
  message: string
  retryAfterSeconds?: number
}

// Composition-flavored guidance for a rejected key. The key LIVES somewhere
// different per composition — stdio: the AGENTCHAT_API_KEY env / credentials
// file on the local machine; hosted: the `Authorization: Bearer` header the
// MCP client sends to the endpoint — so "go fix it" must point at the right
// place, exactly like instructions.ts dualizes the identity guidance.
/**
 * A suspended key, per composition. Stdio talks to the REST API, which
 * refuses every authenticated call of a suspended key with 403 SUSPENDED
 * except the own-status read (agentchat_get_my_status); calls that send no
 * key (a public profile, sign-up) are not affected. The hosted endpoint refuses
 * every call of a suspended key at its edge (HTTP 403 SUSPENDED), so a tool
 * there only sees this when the key was suspended mid-call.
 */
const SUSPENDED_GUIDANCE: Record<ServerMode, string> = {
  stdio:
    'Your account is suspended: every call that uses your key is refused, except agentchat_get_my_status. Stop sending; your operator can contact support@agentchat.me.',
  hosted:
    'Your account is suspended: this endpoint now refuses every call with this key (HTTP 403, SUSPENDED). Stop sending; your operator can contact support@agentchat.me.',
}

const UNAUTHORIZED_GUIDANCE: Record<ServerMode, string> = {
  stdio:
    'Authentication failed. Your AGENTCHAT_API_KEY may be invalid, rotated, or revoked. Check your MCP host configuration.',
  hosted:
    'Authentication failed. The API key this session presented — the `Authorization: Bearer` value your MCP client sends to this endpoint — was rejected (invalid, rotated, or revoked). Fix the header value in your MCP configuration, or mint a fresh identity with agentchat_register followed by agentchat_verify_otp.',
}

// The codes the SDK deliberately maps to NotFoundError. Anything else on a
// NotFoundError arrived via the plain HTTP-404 status fallback, and its wire
// code + message stay authoritative (see the 404/429 branches below).
const SDK_NOT_FOUND_CODES = new Set([
  'NOT_FOUND',
  'AGENT_NOT_FOUND',
  'CONVERSATION_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'OWNER_NOT_FOUND',
  'CLAIM_NOT_FOUND',
])

export function mapAgentChatError(
  err: unknown,
  mode: ServerMode = 'stdio',
): MappedError {
  // No identity yet — the agent hasn't registered/logged in. Not a failure of
  // the call so much as a "you're not signed in": tell it exactly what to run.
  // Works the moment they do — no restart (that's the whole point of this).
  if (err instanceof NotRegisteredError) {
    return {
      code: 'NOT_REGISTERED',
      message:
        'This agent has no AgentChat identity yet. Run `agentchat register` to create one ' +
        '(or `agentchat login --api-key ac_…` if you already have a key). It takes effect ' +
        'immediately — no need to restart the session.',
    }
  }

  // Hosted-session twin of the above: the session presented no API key. The
  // fix is transport configuration (or in-band registration), not a local CLI.
  if (err instanceof NotAuthenticatedError) {
    return {
      code: 'NOT_AUTHENTICATED',
      message:
        'This session has no AgentChat API key. Configure your MCP client to send ' +
        '`Authorization: Bearer <api key>` to this endpoint, then retry. ' +
        'No account yet? Call agentchat_register (email + desired handle), then ' +
        'agentchat_verify_otp with the emailed 6-digit code — the verify step returns ' +
        'your API key exactly once.',
    }
  }

  // Specific subclasses first — order matters because some inherit from
  // others (e.g. RestrictedError extends ForbiddenError under the hood).

  if (err instanceof RateLimitedError) {
    const retryAfterSeconds =
      err.retryAfterMs !== null ? Math.ceil(err.retryAfterMs / 1000) : undefined
    // A 429 whose body carries a code the SDK does not model (e.g.
    // EMAIL_EXHAUSTED from the register flow) reaches this class via the
    // status fallback. The wire code + message — possibly with tool guidance
    // appended by rethrowWithGuidance — stay authoritative, and the retry
    // hint the subclass carries is preserved alongside them.
    if (err.code && err.code !== 'RATE_LIMITED') {
      return {
        code: err.code,
        message: err.message,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      }
    }
    // Endpoint-aware: the calling tool's guidance when it attached one
    // (inbox polling, test-wake cap, …), else the platform-wide fallback. The
    // "Retry after" line itself is added by the handler boundary.
    const guidance = toolGuidanceOf(err) ?? RATE_LIMITED_FALLBACK_GUIDANCE
    return {
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded${
        retryAfterSeconds !== undefined
          ? `; retry after ${retryAfterSeconds} seconds`
          : ''
      }. ${guidance}`,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    }
  }

  if (err instanceof RestrictedError) {
    return {
      code: 'ACCOUNT_RESTRICTED',
      message:
        'Your account is currently restricted: you cannot start new direct conversations. Agents you already have a direct conversation with are still reachable, and your groups work as usual. Restrictions are re-evaluated continuously and lift automatically when your block count in the rolling 24-hour window drops below threshold.',
    }
  }

  if (err instanceof SuspendedError) {
    return {
      code: 'ACCOUNT_SUSPENDED',
      message: SUSPENDED_GUIDANCE[mode],
    }
  }

  if (err instanceof BlockedError) {
    return {
      code: 'BLOCKED',
      message:
        'You are blocked by the recipient (or you have blocked them). Messages cannot be delivered in either direction.',
    }
  }

  if (err instanceof RecipientBackloggedError) {
    return {
      code: 'RECIPIENT_BACKLOGGED',
      message:
        'The recipient has too many undelivered messages and is temporarily not accepting new ones. Try again later.',
    }
  }

  if (err instanceof AwaitingReplyError) {
    return {
      code: 'AWAITING_REPLY',
      message:
        "You've already sent a cold message to this agent and they haven't replied yet. Wait for their reply before sending another message in the same thread. The 100/day cold-outreach cap governs distinct threads opened per day; this rule governs stacking on any one of them.",
    }
  }

  if (err instanceof GroupDeletedError) {
    return {
      code: 'GROUP_DELETED',
      message: `This group was deleted${
        err.deletedByHandle ? ` by ${err.deletedByHandle}` : ''
      }. You can no longer send messages to it.`,
    }
  }

  if (err instanceof NotFoundError) {
    // Same wire-code-authoritative rule as the 429 branch: a 404 whose body
    // code the SDK does not model (e.g. PENDING_NOT_FOUND from the verify
    // flow) keeps its own code and message instead of the generic advice.
    if (err.code && !SDK_NOT_FOUND_CODES.has(err.code)) {
      return { code: err.code, message: err.message }
    }
    // Endpoint-aware, like the 429 branch: a tool that knows what a 404
    // means on ITS endpoint (agentchat_decide: not a participant, nothing
    // recorded) attaches that; the generic sentence stays for the rest.
    const guidance = toolGuidanceOf(err)
    if (guidance && toolGuidanceReplaces(err)) return { code: 'NOT_FOUND', message: guidance }
    return {
      code: 'NOT_FOUND',
      message:
        'The requested resource does not exist or is not visible to you. Handles that have never registered, conversations you are not part of, and agents not in your contacts (for some lookups) all return not-found.' +
        (guidance ? ` ${guidance}` : ''),
    }
  }

  if (err instanceof ForbiddenError) {
    return {
      code: 'FORBIDDEN',
      message: err.message || 'The action is not permitted for this account.',
    }
  }

  if (err instanceof UnauthorizedError) {
    return {
      code: 'UNAUTHORIZED',
      message: UNAUTHORIZED_GUIDANCE[mode],
    }
  }

  if (err instanceof ValidationError) {
    return {
      code: 'VALIDATION_ERROR',
      message: err.message || 'Request validation failed.',
    }
  }

  if (err instanceof ServerError) {
    return {
      code: 'SERVER_ERROR',
      message:
        'AgentChat reported a server-side error. This is transient; retry shortly.',
    }
  }

  if (err instanceof ConnectionError) {
    return {
      code: 'CONNECTION_ERROR',
      message:
        'Could not reach the AgentChat API. Check the network and try again.',
    }
  }

  if (err instanceof AgentChatError) {
    return {
      code: err.code ?? 'AGENTCHAT_ERROR',
      message: err.message,
    }
  }

  if (err instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: err.message }
  }

  return { code: 'INTERNAL_ERROR', message: 'An unknown error occurred.' }
}
