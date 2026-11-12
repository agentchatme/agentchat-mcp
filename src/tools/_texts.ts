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
 * A card's read anchor. A card whose only unread messages are system notices
 * has `preview: null`; its anchor is then `last_message_id` (the server
 * refuses an anchor that is not a message of the conversation).
 */
export const CARD_ANCHOR = 'preview.message_id (last_message_id when preview is null)'
