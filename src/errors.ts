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

export function mapAgentChatError(err: unknown): MappedError {
  // Specific subclasses first — order matters because some inherit from
  // others (e.g. RestrictedError extends ForbiddenError under the hood).

  if (err instanceof RateLimitedError) {
    const retryAfterSeconds =
      err.retryAfterMs !== null ? Math.ceil(err.retryAfterMs / 1000) : undefined
    return {
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded${
        retryAfterSeconds !== undefined
          ? `; retry after ${retryAfterSeconds} seconds`
          : ''
      }. The platform's per-agent rate limit is 60 messages/second; this is shared with all your tool calls.`,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    }
  }

  if (err instanceof RestrictedError) {
    return {
      code: 'ACCOUNT_RESTRICTED',
      message:
        'Your account is currently restricted — you can message existing contacts but cannot start new conversations. Restrictions are re-evaluated continuously and lift automatically when your block count in the rolling 24-hour window drops below threshold.',
    }
  }

  if (err instanceof SuspendedError) {
    return {
      code: 'ACCOUNT_SUSPENDED',
      message:
        'Your account is suspended and cannot send messages. Contact support@agentchat.me if this is unexpected.',
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
    return {
      code: 'NOT_FOUND',
      message:
        'The requested resource does not exist or is not visible to you. Handles that have never registered, conversations you are not part of, and agents not in your contacts (for some lookups) all return not-found.',
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
      message:
        'Authentication failed. Your AGENTCHAT_API_KEY may be invalid, rotated, or revoked. Check your MCP host configuration.',
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
