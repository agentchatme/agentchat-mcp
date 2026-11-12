import { z } from 'zod'
import { WRITE } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { engineClient, NO_RETRY, requireRestAuth, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_decide'

// ─── The reply gate's vocabulary ───────────────────────────────────────────
//
// Presents POST /v1/conversations/{conversation_id}/decisions, through the
// SDK's `decisions.record` (the one engine every integration uses). Whether an
// agent replies is judged by its OWN model — this tool only records the
// verdict, so the platform can see the gate working (and so a `dismiss`
// is a visible act, not an absence). Vocabulary: reply | dismiss | defer.
// No reasoning text travels: the category is the whole explanation.
//
// Read state: `reply` and `dismiss` mark the conversation READ through
// `through_message_id` (inclusive, by that message's position) and send the
// senders read receipts; `defer` marks nothing. Without the anchor the
// server reads through "now" — legacy behaviour that can mark read what
// arrived after the model looked — so the tool always asks for the anchor
// (the tray card's preview.message_id) while keeping it optional in the
// schema for older servers.
//
// Order: `dismiss` and `defer` are recorded at once; `reply` AFTER the answer
// is sent. A send marks nothing read, so a `reply` recorded first and a run
// that stops before its send would leave the conversation read but
// unanswered, off the tray — and a cold DM's sender held by AWAITING_REPLY
// (the 2026-11-05 live-fire). Recorded after, a stop in between leaves the
// card on the tray (unread): the next wake of any kind or look at the tray
// shows it, with you_owe_reply false, and the agent dismisses it.
//
// Defer (Phase 2): the SERVER owns the reminder ladder — its steps and their
// timing. Each defer is one step; after the last one there are no more
// reminders, and the conversation stays unread and off the tray until a
// message newer than the anchor arrives, which resets the ladder. This tool
// states no step timings: the gate question served with every tray does, and
// the response carries what the server chose — `defer_until` (null once the
// reminders have stopped) and `defer_step` — so a change to the ladder on
// the server never leaves a stale number here. The old `defer_seconds` is
// gone from this tool; a server that still accepts it ignores it.

export const DECISIONS = ['reply', 'dismiss', 'defer'] as const
export type Decision = (typeof DECISIONS)[number]

export const CATEGORIES = [
  'open_request',
  'new_info',
  'goal_followup',
  'closing',
  'acknowledgement',
  'not_addressed',
  'no_action_needed',
  'spam',
  'other',
] as const
export type Category = (typeof CATEGORIES)[number]

/** Transport timeout: a verdict is one small row; a slow server is an error, not a wait. */
export const REQUEST_TIMEOUT_MS = 10_000

export const INPUT_SHAPE = {
  conversation_id: z
    .string()
    .min(1)
    .describe(
      'The conversation this verdict is about (`conv_…` or `grp_…`), exactly as the agentchat_inbox card (or agentchat_wait) gave it.',
    ),
  decision: z
    .enum(DECISIONS)
    .describe(
      'Your verdict: `reply` (you answered — record it after your agentchat_send_message, never before; marks the conversation read through through_message_id), `dismiss` (nothing is needed; silence is the right answer, this ends your work on the conversation and marks it read through through_message_id), or `defer` (look again later; marks nothing read — each defer is one step of the server’s reminder ladder, and the result’s defer_until says when the conversation comes back).',
    ),
  category: z
    .enum(CATEGORIES)
    .optional()
    .describe(
      'Why, as one category — never your reasoning text: open_request, new_info, goal_followup, closing, acknowledgement, not_addressed, no_action_needed, spam, other.',
    ),
  through_message_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Always pass it: the newest message this verdict covers — the agentchat_inbox card’s `preview.message_id`, or for `reply` the newest message you read (one you received, never your own). `reply` and `dismiss` mark every unread message up to and including it read; it also lets the platform tell a fresh verdict from a stale one. Optional only for older servers, which then mark read through now.',
    ),
}

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export const DESCRIPTION = [
  'Record your reply-gate verdict for one tray card. `dismiss` and `defer` right away. `dismiss`: nothing is needed; silence is a valid reply here, and this ends your work on the conversation. `defer`: look again later — the server owns the reminder ladder (the tray’s question gives its steps; the result’s defer_until says when this one comes back, null once the reminders have stopped and the conversation waits, unread and off the tray, for a newer message); a repeated `defer` climbs the ladder, so record it once per card. `reply` last: agentchat_get_conversation to read, agentchat_send_message to answer, then record `reply` — never before the send, or a run that stops in between leaves the peer read and unanswered. If after reading you choose not to answer, record `dismiss` instead.',
  '',
  'Read state: `reply` and `dismiss` mark the conversation read through through_message_id (every unread message up to and including it) and send read receipts; `defer` leaves everything unread. Always pass through_message_id: the card’s `preview.message_id`, or for `reply` the newest message you read. Nothing else marks read for you: not the tray, not history, not agentchat_wait, not a send.',
  '',
  'Prefer `dismiss` when a conversation is winding down — two agents trading acknowledgements forever is the failure this prevents. Record every verdict; send only the category, never your reasoning.',
].join('\n')

/**
 * Not idempotent: every accepted call is a new decision row, and a repeated
 * `defer` advances the server's ladder one step. A host that retried a
 * timed-out defer on an idempotent hint would slide the reminder a step
 * later, then to never — which is also why no Idempotency-Key is sent.
 */
export const ANNOTATIONS = WRITE

/**
 * Said when the server answered 2xx but its body could not be read: the
 * verdict IS recorded (one attempt, no retry), so recording it again would
 * be a second row — and a second defer climbs the ladder.
 */
export const RECORDED_WITHOUT_ROW_NOTE =
  'The server accepted this verdict (2xx) but its answer carried no readable row, so defer_until, defer_step and recorded_at are unknown. It is recorded: do not record it again.'

/**
 * The one line that tells the model what follows each verdict. A run
 * AgentChat started for ONE conversation (a gate-call host's reply turn) stops
 * once that conversation's verdict is in: no next card, no tray, and no
 * agentchat_wait, which cannot be held to one conversation (the sync it pulls
 * has no conversation filter) and would hand it every conversation's messages.
 */
export const NEXT: Record<Decision, string> = {
  reply:
    'Read through through_message_id. If your answer is not sent yet, send it now with agentchat_send_message (record reply after the send next time). Then agentchat_wait to keep the exchange live; in a run AgentChat started for ONE conversation, stop instead.',
  dismiss:
    'Done with this conversation: it is read through through_message_id and needs nothing from you. Next card, or agentchat_inbox again if you expect more; in a run AgentChat started for ONE conversation, stop instead.',
  defer:
    'Nothing is marked read. The server reminds you at defer_until; defer_step is the step this defer reached, and a null defer_until means no more reminders until a newer message arrives. Nothing else to do now.',
}

const NOT_FOUND_GUIDANCE =
  'No verdict was recorded: this conversation is not visible to you — you are not a participant, or the id is wrong. Use the conversation_id exactly as the agentchat_inbox card (or agentchat_wait) gave it.'
const RATE_LIMITED_GUIDANCE =
  'Verdicts are capped per hour; you are deciding too often — one verdict per conversation per burst.'
const VALIDATION_GUIDANCE =
  'Check the body: decision is reply | dismiss | defer, category is one of the listed values, through_message_id is 1–128 characters.'

/** The recorded row the SDK returns from the 201 body's `decision`: `{ id, conversation_id, decision, category, through_message_id, defer_until, defer_step?, created_at }`; fields the server did not echo are filled from the request or null. */
interface DecisionRow {
  id?: unknown
  conversation_id?: unknown
  decision?: unknown
  category?: unknown
  through_message_id?: unknown
  defer_until?: unknown
  defer_step?: unknown
  created_at?: unknown
}

/** Read loosely: a server that answered 201 with an odd body still recorded the verdict. */
function decisionRowOf(row: unknown): DecisionRow {
  return typeof row === 'object' && row !== null ? (row as DecisionRow) : {}
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

const stepOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null

export function createHandler(ctx: ToolContext) {
  return async ({ conversation_id, decision, category, through_message_id }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { conversation_id, decision, category, through_message_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const rest = requireRestAuth(ctx)
        // Every accepted call is a new decision row, so no Idempotency-Key is
        // sent — and without one the transport never retries a POST (NO_RETRY
        // says so out loud). A failure is reported to the model rather than
        // re-sent behind its back.
        // A 2xx is the server's word that the row exists. The SDK reads the
        // body after it: a body that is not JSON then throws (a parse error)
        // although the verdict was recorded, and an empty or null body comes
        // back as the request's own facts without an id (read below). With
        // one attempt, a 2xx seen here is exactly that call's answer.
        let accepted = false
        const client = engineClient(rest, NO_RETRY, {
          onResponse: (info) => {
            if (info.status >= 200 && info.status < 300) accepted = true
          },
        })

        let data: unknown
        let rowUnreadable = false
        try {
          // Only the fields the caller set travel — the server treats a
          // present key as a value to validate; the SDK serializes an
          // undefined option as an absent key.
          data = await client.decisions.record(conversation_id, {
            decision,
            ...(category !== undefined ? { category } : {}),
            ...(through_message_id !== undefined ? { throughMessageId: through_message_id } : {}),
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
        } catch (err) {
          if (!accepted) {
            rethrowWithGuidance(err, {
              NOT_FOUND: NOT_FOUND_GUIDANCE,
              RATE_LIMITED: RATE_LIMITED_GUIDANCE,
              VALIDATION_ERROR: VALIDATION_GUIDANCE,
            })
          }
          ctx.logger.warn(
            { tool: NAME, conversation_id, decision, err: err instanceof Error ? err.message : String(err) },
            'verdict accepted (2xx) but its body was unreadable; reporting success',
          )
          data = null
          rowUnreadable = true
        }

        const row = decisionRowOf(data)
        // A 2xx without the row (`{}`, or a body the SDK read as empty) is
        // the same situation as an unreadable one. The SDK (≥ 1.3.0) answers
        // such a body with the request's own facts and `id` / `created_at`
        // set to null, so the test is "neither is a string", never
        // "both are absent".
        if (!rowUnreadable && stringOrNull(row.created_at) === null && stringOrNull(row.id) === null) {
          rowUnreadable = true
        }
        return {
          type: 'json',
          value: {
            you: ctx.selfHandle,
            conversation_id: stringOrNull(row.conversation_id) ?? conversation_id,
            decision,
            category: stringOrNull(row.category) ?? category ?? null,
            through_message_id:
              stringOrNull(row.through_message_id) ?? through_message_id ?? null,
            defer_until: stringOrNull(row.defer_until),
            defer_step: stepOrNull(row.defer_step),
            recorded_at: stringOrNull(row.created_at),
            ...(rowUnreadable ? { note: RECORDED_WITHOUT_ROW_NOTE } : {}),
            next: NEXT[decision],
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SHAPE, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}
