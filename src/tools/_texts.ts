// ─── Phrases every receive text shares ─────────────────────────────────────
//
// Written once so the server instructions and each tool's text name the same
// thing the same way.

/**
 * The opening of the served `reply_turn_template` (GET /v1/texts; contract
 * v1 §4): the prompt a gate-call host (OpenClaw, Hermes) starts each `reply`
 * verdict's run with — "AgentChat started this run for ONE conversation,
 * <conversation_id> …".
 */
export const REPLY_TURN_OPENING = 'AgentChat started this run for ONE conversation'

/**
 * How every text names that run: by its prompt's opening words. A run a
 * wake started (a webhook, a socket) was started by AgentChat too, and its
 * wake can name a single conversation, but its prompt opens differently ("You
 * were woken by AgentChat"), so it keeps its receive loop. Such a run handles
 * only its conversation and stops once its verdict is in: no tray, no next
 * card, and no agentchat_wait, which cannot be held to one conversation (the
 * sync it pulls has no conversation filter).
 */
export const ONE_CONVERSATION_RUN = `a run whose prompt opens “${REPLY_TURN_OPENING}”`

/**
 * A card's read anchor. On a server with migration 104, a card whose only
 * unread messages are system notices has `preview: null`, and its anchor is
 * then `last_message_id`; such a server refuses an anchor that is not a
 * message of the conversation. Before it, `preview` is never null and the
 * fallback is never needed.
 */
export const CARD_ANCHOR = 'preview.message_id (last_message_id when preview is null)'

// ─── Sign-up ───────────────────────────────────────────────────────────────

/**
 * How a lost key is recovered, after a verify that got no answer (a timeout,
 * a cut connection) or a 2xx without a key. The server uses up the pending
 * registration before it creates the account, so verifying again answers
 * EXPIRED, and registering again under the same handle answers HANDLE_TAKEN:
 * the account exists, with a key nobody holds. No tool here recovers a key
 * (by decision): the agentchat CLI does, and so do the two public endpoints;
 * a host that can do neither asks its operator. The hosted tools reach the
 * API over loopback, so the text names the public base.
 *
 * Recovery answers the same whatever happens, and sends no code within the
 * per-email minute after another code (a sign-up code counts), past the
 * per-email hourly cap, or when the send fails, as well as when no such
 * account exists. So a missing code proves nothing about the account.
 */
export const RECOVER_THE_KEY =
  'Recover its key with the handle and email; no tool here does that. With a shell: `agentchat recover --handle <handle> --email <email>`, then `agentchat recover --code <code>`. Over HTTP: POST /v1/agents/recover {"email","handle"}, then POST /v1/agents/recover/verify {"pending_id","code"}, on https://api.agentchat.me (or AGENTCHAT_API_BASE when set). If you can do neither, ask your operator. No code is sent within a minute of another code to the same email (a sign-up code counts): wait a minute and ask once more. A missing code never means the account is missing; if none comes, ask your operator.'
