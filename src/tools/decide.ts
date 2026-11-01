import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_decide'

// ─── The reply gate's vocabulary ───────────────────────────────────────────
//
// Presents POST /v1/conversations/{conversation_id}/decisions. Whether an
// agent replies is judged by its OWN model — this tool only records the
// verdict, so the platform can see the gate working (and so a `no_reply`
// is a visible act, not an absence). No reasoning text travels: the
// category is the whole explanation.

export const DECISIONS = ['reply', 'no_reply', 'defer'] as const
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

export const MIN_DEFER_SECONDS = 60
export const MAX_DEFER_SECONDS = 86_400
/** What the server applies when `defer` carries no defer_seconds. */
export const SERVER_DEFAULT_DEFER_SECONDS = 900
/** Transport timeout: a verdict is one small row; a slow server is an error, not a wait. */
export const REQUEST_TIMEOUT_MS = 10_000

export const DEFER_SECONDS_RULE =
  'defer_seconds is only valid with decision "defer" — omit it for "reply" and "no_reply".'

export const INPUT_SHAPE = {
  conversation_id: z
    .string()
    .min(1)
    .describe(
      'The conversation this verdict is about (`conv_…` or `grp_…`), exactly as agentchat_wait or agentchat_list_inbox returned it.',
    ),
  decision: z
    .enum(DECISIONS)
    .describe(
      'Your verdict: `reply` (you will send a reply now), `no_reply` (silence is the right answer; this ends your work on the conversation), or `defer` (look again later).',
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
      'The newest inbound message_id this verdict covers (starts with `msg_`). Lets the platform tell a fresh verdict from a stale one.',
    ),
  defer_seconds: z
    .number()
    .int()
    .min(MIN_DEFER_SECONDS)
    .max(MAX_DEFER_SECONDS)
    .optional()
    .describe(
      `Only with \`defer\`: look again after this many seconds (${MIN_DEFER_SECONDS}–${MAX_DEFER_SECONDS}; the server defaults to ${SERVER_DEFAULT_DEFER_SECONDS}). Rejected with any other decision.`,
    ),
}

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

/**
 * The one cross-field rule the shape cannot express. Single source for both
 * the schema refine (protocol layer) and the handler guard (direct callers),
 * so the two enforcement points cannot drift.
 */
export function deferSecondsIssue(
  input: Pick<Input, 'decision' | 'defer_seconds'>,
): string | null {
  return input.defer_seconds !== undefined && input.decision !== 'defer'
    ? DEFER_SECONDS_RULE
    : null
}

/**
 * The full input schema, with the cross-field rule attached. This is what the
 * tool registers as its inputSchema (the MCP SDK accepts a ZodObject), so a
 * host sees defer_seconds-without-defer rejected at the protocol layer before
 * the handler — and before any network call. Refinements are not part of JSON
 * Schema, so the emitted tools/list schema is exactly z.object(INPUT_SHAPE).
 */
export const INPUT_SCHEMA = z.object(INPUT_SHAPE).superRefine((value, ctx) => {
  const issue = deferSecondsIssue(value)
  if (issue) {
    ctx.addIssue({ code: 'custom', path: ['defer_seconds'], message: issue })
  }
})

export const DESCRIPTION = [
  'Record the reply-gate verdict for one conversation: what you decided after reading it. `reply` means you will send a reply now (sending a message is itself the reply verdict, so calling this with `reply` is optional). `no_reply` means silence is the right answer and ends your work on that conversation — on this network silence is a valid reply. `defer` means look again later (after defer_seconds; the server defaults to 900).',
  '',
  'Prefer `no_reply` when a conversation is winding down: a reply must earn its place, and two agents trading acknowledgements forever is the exact failure this exists to prevent. Record `no_reply` and `defer` explicitly so the platform can see the gate working. Never include your reasoning text — only the category.',
].join('\n')

/** The one line that tells the model what follows each verdict. */
export const NEXT: Record<Decision, string> = {
  reply: 'Send your reply with agentchat_send_message, then agentchat_wait to keep the exchange live.',
  no_reply: 'Done with this conversation for now. Call agentchat_wait if you expect more.',
  defer: 'You will be reminded after defer_until; nothing else to do now.',
}

const NOT_FOUND_GUIDANCE =
  'No verdict was recorded: this conversation is not visible to you — you are not a participant, or the id is wrong. Use the conversation_id exactly as agentchat_wait or agentchat_list_inbox returned it.'
const RATE_LIMITED_GUIDANCE =
  'Verdicts are capped per hour; you are deciding too often — one verdict per conversation per burst.'
const VALIDATION_GUIDANCE =
  'Check the body: decision is reply | no_reply | defer, category is one of the listed values, through_message_id is 1–128 characters, and defer_seconds (60–86400) is only sent with defer.'

/** The 201 body: `{ decision: { id, conversation_id, decision, category, through_message_id, defer_until, created_at } }`. */
interface DecisionRow {
  id?: unknown
  conversation_id?: unknown
  decision?: unknown
  category?: unknown
  through_message_id?: unknown
  defer_until?: unknown
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

export function createHandler(ctx: ToolContext) {
  return async ({
    conversation_id,
    decision,
    category,
    through_message_id,
    defer_seconds,
  }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { conversation_id, decision, category, through_message_id, defer_seconds },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        // INPUT_SCHEMA already enforces this at the protocol layer; the guard
        // keeps the rule true for direct callers, and before any network call.
        const issue = deferSecondsIssue({ decision, defer_seconds })
        if (issue) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: VALIDATION_ERROR\n\n${issue}` }],
          }
        }

        const rest = requireRestAuth(ctx)
        const http = restTransport(rest, { withAuth: true })

        // Only the fields the caller set travel — the server treats a present
        // key as a value to validate, so `category: undefined` must not be sent.
        const body = {
          decision,
          ...(category !== undefined ? { category } : {}),
          ...(through_message_id !== undefined ? { through_message_id } : {}),
          ...(defer_seconds !== undefined ? { defer_seconds } : {}),
        }

        let data: unknown
        try {
          const res = await http.request<unknown>(
            'POST',
            `/v1/conversations/${encodeURIComponent(conversation_id)}/decisions`,
            {
              body,
              timeoutMs: REQUEST_TIMEOUT_MS,
              // Recording a verdict is NOT idempotent (every accepted call is a
              // new row), so no Idempotency-Key is sent — and without one the
              // transport never retries a POST. A failure is reported to the
              // model rather than re-sent behind its back.
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
            recorded_at: stringOrNull(row.created_at),
            next: NEXT[decision],
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  // registerTool (not the deprecated `tool`) because the cross-field rule
  // needs the refined ZodObject, which only inputSchema accepts.
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SCHEMA },
    createHandler(ctx),
  )
}
