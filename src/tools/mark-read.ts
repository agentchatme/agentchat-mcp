import { randomUUID } from 'node:crypto'
import type { RetryPolicy } from 'agentchatme'
import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_mark_read'

// ─── Read state ────────────────────────────────────────────────────────────
//
// Two message states only. DELIVERED = this agent's machine received the
// message (a socket ack, /sync/ack, or a pull). READ = the agent looked: a
// verdict (agentchat_decide reply/dismiss) or an explicit mark-read. A tray
// card is a preview, like a phone banner — reading the tray marks nothing,
// and neither does history (agentchat_get_conversation) or a pull
// (agentchat_wait, which marks delivered only).
//
// This tool is the explicit mark-read, in two forms:
//   * conversation_id + through_message_id → POST /v1/conversations/{id}/read
//     marks every unread message in the conversation up to and including the
//     anchor (by its position) and sends the senders read receipts. One call
//     per conversation, which is how a real inbox works.
//   * message_id → POST /v1/messages/{id}/read, one message. The original
//     form, kept for compatibility and for servers without the conversation
//     endpoint.
// Exactly one form per call; the rule is enforced at the protocol layer (the
// refined input schema) and again in the handler for direct callers.

/** Transport timeout: a read marker is one small write; a slow server is an error, not a wait. */
export const REQUEST_TIMEOUT_MS = 10_000
/**
 * Marking read through an anchor is idempotent (forward-only; the same anchor
 * twice marks nothing more), so a couple of quick retries under one
 * Idempotency-Key are safe — the same policy as the wait tool's cursor ack.
 */
export const READ_RETRY_POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 1_000 }

export const FORM_RULE =
  'Pass exactly one form: either message_id alone, or conversation_id together with through_message_id.'

export const INPUT_SHAPE = {
  conversation_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Conversation form: the conversation (`conv_…` or `grp_…`) to mark read, exactly as the agentchat_inbox card gave it. Requires through_message_id; do not combine with message_id.',
    ),
  through_message_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Conversation form: mark every unread message up to and including this one (by its position in the conversation) — normally the card’s `preview.message_id`, or the newest message_id you read. Must be a message of conversation_id.',
    ),
  message_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Single-message form: the one message_id (starts with `msg_`) to mark read. Compatibility path — prefer the conversation form; use this on a server that has no conversation read endpoint yet.',
    ),
}

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export type Form =
  | { kind: 'conversation'; conversation_id: string; through_message_id: string }
  | { kind: 'message'; message_id: string }

/**
 * The one cross-field rule the shape cannot express, resolved to the form
 * the call means. Single source for the schema refine (protocol layer) and
 * the handler guard (direct callers), so the two cannot drift.
 */
export function formOf(input: Input): Form | { issue: string } {
  const hasMessage = input.message_id !== undefined
  const hasConversation = input.conversation_id !== undefined
  const hasThrough = input.through_message_id !== undefined
  if (hasMessage && !hasConversation && !hasThrough) {
    return { kind: 'message', message_id: input.message_id as string }
  }
  if (!hasMessage && hasConversation && hasThrough) {
    return {
      kind: 'conversation',
      conversation_id: input.conversation_id as string,
      through_message_id: input.through_message_id as string,
    }
  }
  return { issue: FORM_RULE }
}

/**
 * The full input schema with the cross-field rule attached: what the tool
 * registers as its inputSchema, so a host rejects a mixed or empty call
 * before the handler and before any network call. Refinements are not part
 * of JSON Schema, so the emitted tools/list schema is exactly
 * z.object(INPUT_SHAPE) — every field optional, the rule in the text.
 */
export const INPUT_SCHEMA = z.object(INPUT_SHAPE).superRefine((value, ctx) => {
  const form = formOf(value)
  if ('issue' in form) {
    ctx.addIssue({ code: 'custom', path: [], message: form.issue })
  }
})

export const DESCRIPTION = [
  'Mark read: tell the senders you looked (the read receipt, the blue-checkmark equivalent). Two forms, exactly one per call. Conversation form — conversation_id + through_message_id — marks every unread message in that conversation up to and including that message read, in one call; pass the card’s `preview.message_id` or the newest message_id you read. Single-message form — message_id alone — marks one message; it is the compatibility path, and the fallback on a server that answers NOT_FOUND to the conversation form.',
  '',
  'Usually you do not need this: agentchat_decide `reply` and `dismiss` already mark the conversation read through their through_message_id. Call it when you read a conversation without recording a verdict, or when a newer message arrived after your verdict and you have now read it. Looking never marks read — not agentchat_inbox (a card is a preview), not agentchat_get_conversation (history), not agentchat_wait (it marks delivered only). Marking read is forward-only; a message never goes back to delivered.',
].join('\n')

const NOT_FOUND_GUIDANCE =
  'Nothing was marked: this conversation is not visible to you (not a participant, or the id is wrong — use the conversation_id exactly as the agentchat_inbox card gave it), or this server has no conversation read endpoint yet — then mark messages one at a time with message_id.'
const MESSAGE_NOT_FOUND_GUIDANCE =
  'Nothing was marked: through_message_id is not a message of this conversation. Pass the card’s preview.message_id, or a message_id agentchat_get_conversation returned for this same conversation.'
const VALIDATION_GUIDANCE =
  'Check the body: through_message_id is required for the conversation form and is one message id (1–128 characters).'

function readCountOf(data: unknown): number | null {
  if (typeof data === 'object' && data !== null && 'read' in data) {
    const read = (data as { read: unknown }).read
    if (typeof read === 'number' && Number.isInteger(read) && read >= 0) return read
  }
  return null
}

export function createHandler(ctx: ToolContext) {
  return async (input: Input) => {
    const { conversation_id, through_message_id, message_id } = input
    return withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { conversation_id, through_message_id, message_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        // INPUT_SCHEMA already enforces this at the protocol layer; the guard
        // keeps the rule true for direct callers, and before any network call.
        const form = formOf(input)
        if ('issue' in form) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: VALIDATION_ERROR\n\n${form.issue}` }],
          }
        }

        if (form.kind === 'message') {
          await ctx.client.markAsRead(form.message_id)
          return { type: 'json', value: { ok: true, message_id: form.message_id } }
        }

        const rest = requireRestAuth(ctx)
        const http = restTransport(rest, { withAuth: true })
        let data: unknown
        try {
          const res = await http.request<unknown>(
            'POST',
            `/v1/conversations/${encodeURIComponent(form.conversation_id)}/read`,
            {
              body: { through_message_id: form.through_message_id },
              timeoutMs: REQUEST_TIMEOUT_MS,
              // Idempotent, so a transient failure is retried under one key
              // (see READ_RETRY_POLICY); a verdict POST, by contrast, never is.
              idempotencyKey: randomUUID(),
              retry: READ_RETRY_POLICY,
            },
          )
          data = res.data
        } catch (err) {
          rethrowWithGuidance(err, {
            NOT_FOUND: NOT_FOUND_GUIDANCE,
            MESSAGE_NOT_FOUND: MESSAGE_NOT_FOUND_GUIDANCE,
            VALIDATION_ERROR: VALIDATION_GUIDANCE,
          })
        }
        return {
          type: 'json',
          value: {
            ok: true,
            conversation_id: form.conversation_id,
            through_message_id: form.through_message_id,
            // How many messages this call marked; 0 means they were read already.
            read: readCountOf(data),
          },
        }
      },
    )
  }
}

export const register: ToolRegistration = (server, ctx) => {
  // registerTool (not the deprecated `tool`) because the exactly-one-form
  // rule needs the refined ZodObject, which only inputSchema accepts.
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SCHEMA },
    createHandler(ctx),
  )
}
