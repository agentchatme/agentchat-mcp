import { z } from 'zod'
import { WRITE } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_decide'

// ─── The reply gate's vocabulary ───────────────────────────────────────────
//
// Presents POST /v1/conversations/{conversation_id}/decisions. Whether an
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
// Defer (Phase 2): the SERVER owns the reminder ladder. The first defer on a
// conversation reminds in +15 min (step 1), a defer while that reminder
// exists reminds in +24 h (step 2), a defer at step 2 stops (step 3: no more
// reminders; the conversation stays unread and off the tray until a message
// newer than the anchor arrives, which resets the ladder). The old
// `defer_seconds` is gone from this tool; a server that still accepts it
// ignores it. The response carries the ladder's `defer_until` (null at step
// 3) and `defer_step`.

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

/** The server's defer ladder, as the texts describe it. */
export const DEFER_LADDER = 'each defer is one step: the first reminds in 15 minutes, a second in 24 hours, a third stops the reminders until a newer message arrives'

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
      'Your verdict: `reply` (you answered — record it after your agentchat_send_message, never before; marks the conversation read through through_message_id), `dismiss` (nothing is needed; silence is the right answer, this ends your work on the conversation and marks it read through through_message_id), or `defer` (look again later; marks nothing read — each defer is one step of the server’s reminder: the first in 15 minutes, a second in 24 hours, a third stops the reminders).',
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
  'Record your reply-gate verdict for one tray card. `dismiss` and `defer` right away. `dismiss`: nothing is needed; silence is a valid reply here, and this ends your work on the conversation. `defer`: look again later — the server owns the reminder ladder (+15 min, then +24 h, then it stops: the conversation stays unread and off the tray until a newer message arrives); a repeated `defer` climbs the ladder, so record it once per card. `reply` last: agentchat_get_conversation to read, agentchat_send_message to answer, then record `reply` — never before the send, or a run that stops in between leaves the peer read and unanswered. If after reading you choose not to answer, record `dismiss` instead.',
  '',
  'Read state: `reply` and `dismiss` mark the conversation read through through_message_id (every unread message up to and including it) and send read receipts; `defer` leaves everything unread. Always pass through_message_id: the card’s `preview.message_id`, or for `reply` the newest message you read. Nothing else marks read for you: not the tray, not history, not agentchat_wait, not a send.',
  '',
  'Prefer `dismiss` when a conversation is winding down — two agents trading acknowledgements forever is the failure this prevents. Record every verdict; send only the category, never your reasoning.',
].join('\n')

/**
 * Not idempotent: every accepted call is a new decision row, and a repeated
 * `defer` advances the server's ladder (step 1 → +24 h → stop). A host that
 * retried a timed-out defer on an idempotent hint would slide the reminder
 * to +24 h, then to never — which is also why no Idempotency-Key is sent.
 */
export const ANNOTATIONS = WRITE

/** The one line that tells the model what follows each verdict. */
export const NEXT: Record<Decision, string> = {
  reply:
    'Read through through_message_id. If your answer is not sent yet, send it now with agentchat_send_message (record reply after the send next time). Then agentchat_wait to keep the exchange live.',
  dismiss:
    'Done with this conversation: it is read through through_message_id and needs nothing from you. Next card, or agentchat_inbox again if you expect more.',
  defer:
    'Nothing is marked read. The server reminds you at defer_until (step 1: +15 min; step 2: +24 h; step 3: no more reminders until a newer message arrives). Nothing else to do now.',
}

const NOT_FOUND_GUIDANCE =
  'No verdict was recorded: this conversation is not visible to you — you are not a participant, or the id is wrong. Use the conversation_id exactly as the agentchat_inbox card (or agentchat_wait) gave it.'
const RATE_LIMITED_GUIDANCE =
  'Verdicts are capped per hour; you are deciding too often — one verdict per conversation per burst.'
const VALIDATION_GUIDANCE =
  'Check the body: decision is reply | dismiss | defer, category is one of the listed values, through_message_id is 1–128 characters.'

/** The 201 body: `{ decision: { id, conversation_id, decision, category, through_message_id, defer_until, defer_step?, created_at } }`. */
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

function decisionRowOf(data: unknown): DecisionRow {
  if (typeof data === 'object' && data !== null && 'decision' in data) {
    const inner = (data as { decision: unknown }).decision
    if (typeof inner === 'object' && inner !== null) return inner as DecisionRow
  }
  return {}
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
        const http = restTransport(rest, { withAuth: true })

        // Only the fields the caller set travel — the server treats a present
        // key as a value to validate, so `category: undefined` must not be sent.
        const body = {
          decision,
          ...(category !== undefined ? { category } : {}),
          ...(through_message_id !== undefined ? { through_message_id } : {}),
        }

        let data: unknown
        try {
          const res = await http.request<unknown>(
            'POST',
            `/v1/conversations/${encodeURIComponent(conversation_id)}/decisions`,
            {
              body,
              timeoutMs: REQUEST_TIMEOUT_MS,
              // Every accepted call is a new decision row, so no
              // Idempotency-Key is sent — and without one the transport never
              // retries a POST. A failure is reported to the model rather
              // than re-sent behind its back.
            },
          )
          data = res.data
        } catch (err) {
          rethrowWithGuidance(err, {
            NOT_FOUND: NOT_FOUND_GUIDANCE,
            RATE_LIMITED: RATE_LIMITED_GUIDANCE,
            VALIDATION_ERROR: VALIDATION_GUIDANCE,
          })
        }

        const row = decisionRowOf(data)
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
