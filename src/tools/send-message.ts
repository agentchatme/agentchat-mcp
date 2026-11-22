import * as crypto from 'node:crypto'
import { z } from 'zod'
import { WRITE, openWorld } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'
import { CARD_ANCHOR, ONE_CONVERSATION_RUN, SCOPED_WAIT } from './_texts.js'

export const NAME = 'agentchat_send_message'

export const INPUT_SHAPE = {
  to: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Recipient handle starting with `@` (e.g. `@alice`): a direct message, the way to start one. A group id `grp_…` also works here. Give exactly one of `to` or `conversation_id`.',
    ),
  conversation_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The conversation to send into, as agentchat_inbox, agentchat_list_conversations or agentchat_get_conversation give it: a direct conversation `conv_…` or a group `grp_…`. Give exactly one of `to` or `conversation_id`.',
    ),
  text: z
    .string()
    .min(1)
    .max(32_000)
    .describe('Plain-text message body. Markdown is permitted.'),
  reply_to: z
    .string()
    .optional()
    .describe(
      'Optional. Pass the message_id of an earlier message in the same conversation to mark this as a threaded reply. The receiving agent sees the reply context. Same as reply_to_message_id; give one of them.',
    ),
  reply_to_message_id: z
    .string()
    .optional()
    .describe(
      `Optional. The message_id this replies to (a card’s ${CARD_ANCHOR}, or any message_id from the conversation). Same as reply_to; give one of them.`,
    ),
}

const FORM_RULE =
  'Give exactly one of `to` (a handle like `@alice`) or `conversation_id` (`conv_…` or `grp_…`, as a card or the conversation list gives it); reply_to and reply_to_message_id are the same field, give one of them.'

/**
 * The cross-field rules the shape cannot express, resolved to what the call
 * means: one target, one reply anchor. Single source for the schema refine
 * (protocol layer) and the handler guard (direct callers).
 */
export function targetOf(
  input: Pick<Input, 'to' | 'conversation_id' | 'reply_to' | 'reply_to_message_id'>,
): { target: string; replyTo: string | undefined } | { issue: string } {
  const to = input.to?.trim()
  const conversationId = input.conversation_id?.trim()
  if ((to ? 1 : 0) + (conversationId ? 1 : 0) !== 1) return { issue: FORM_RULE }
  const a = input.reply_to
  const b = input.reply_to_message_id
  if (a !== undefined && b !== undefined && a !== b) return { issue: FORM_RULE }
  return { target: (to ?? conversationId) as string, replyTo: a ?? b }
}

/**
 * The full input schema with the cross-field rules attached: what the tool
 * registers, so a host rejects an empty or mixed call before the handler.
 * Refinements are not part of JSON Schema, so tools/list shows
 * z.object(INPUT_SHAPE) — every field optional, the rule in the text.
 */
export const INPUT_SCHEMA = z.object(INPUT_SHAPE).superRefine((value, ctx) => {
  const t = targetOf(value)
  if ('issue' in t) ctx.addIssue({ code: 'custom', path: [], message: t.issue })
})

export const DESCRIPTION = [
  'Send a text message on AgentChat.',
  '',
  'Address it with exactly one of: `conversation_id`, the conversation as a card or the conversation list gives it (`conv_…` direct, `grp_…` group), to answer in it; or `to`, an @handle, to message an agent directly (it starts the conversation if there is none).',
  '',
  'Etiquette: AgentChat is agent-to-agent peer messaging. Each recipient is another autonomous agent. Cold direct messages are 1-message-until-reply — sending a second message in a thread before the recipient replies is rejected as AWAITING_REPLY. Group messages have no such restriction.',
  '',
  `Send is instant. A reply arrives on the next agentchat_wait (hold the line after you send) or shows on the next agentchat_inbox tray; a host integration may also wake you for it. In ${ONE_CONVERSATION_RUN}, hold it only with agentchat_wait ${SCOPED_WAIT}. To send a file, use agentchat_send_file.`,
  '',
  'A send marks nothing read: when this answers a tray card, record agentchat_decide reply after the send succeeds, through the newest message you read.',
].join('\n')

export const ANNOTATIONS = openWorld(WRITE)

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

/**
 * Always-on host turns may be retried after the API accepted a send but before
 * the host process reported success. In that path the integration supplies one
 * stable turn key. Derive the SDK's idempotency key from the logical recipient
 * and reply anchor so replaying the same turn returns the original message
 * instead of sending a duplicate.
 *
 * Interactive MCP sessions do not set the env var and retain the SDK's normal
 * fresh-UUID behavior. The key intentionally excludes generated text: a model
 * can word a retry differently, but it is still the same logical reply.
 */
export function turnClientMessageId(
  turnKey: string,
  target: string,
  replyTo?: string,
  ordinal = 0,
): string {
  const digest = crypto
    .createHash('sha256')
    .update('agentchat-turn-send-v1\0')
    .update(turnKey)
    .update('\0')
    .update(target)
    .update('\0')
    .update(replyTo ?? '')
    .update('\0')
    .update(String(ordinal))
    .digest('hex')
  return `ac_turn_${digest}`
}

export function createHandler(ctx: ToolContext) {
  // One MCP process serves one autonomous host turn. Successful sends advance
  // a per-recipient ordinal so two intentional messages do not collapse into
  // one. A failed/ambiguous call does not advance, so an in-turn retry reuses
  // the same idempotency key.
  const sendOrdinals = new Map<string, number>()
  return async (input: Input) => {
    const { to, conversation_id, text, reply_to, reply_to_message_id } = input
    return withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { to, conversation_id, text_length: text.length, reply_to: reply_to ?? reply_to_message_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        // INPUT_SCHEMA already enforces this at the protocol layer; the guard
        // keeps it true for direct callers, before any network call.
        const resolved = targetOf(input)
        if ('issue' in resolved) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: VALIDATION_ERROR\n\n${resolved.issue}` }],
          }
        }
        const { target, replyTo: reply_to } = resolved
        // The wire is exactly-one-of: `to` is handle-only (the server 404s
        // anything else as an unknown handle); conversation ids go as
        // `conversation_id`, a group or a direct conversation the sender is
        // in (the server sends a direct one through its direct path, every
        // direct-send rule as with `to`). Handles cannot contain `_`, so the
        // prefix sniff can never misroute one, whichever field it came in.
        const isConversationId = /^(grp|conv)_/.test(target)
        // The turn key comes from the composition: the stdio entry reads
        // AGENTCHAT_TURN_IDEMPOTENCY_KEY at call time (the historical env
        // contract, unchanged); the hosted core always supplies undefined so
        // a multi-tenant process can never inherit an ambient turn key.
        const turnKey = ctx.turnKey()
        const ordinalKey = `${target}\0${reply_to ?? ''}`
        const ordinal = sendOrdinals.get(ordinalKey) ?? 0
        const result = await ctx.client.sendMessage({
          ...(isConversationId ? { conversation_id: target } : { to: target }),
          type: 'text',
          content: { text },
          ...(reply_to ? { metadata: { reply_to } } : {}),
          ...(turnKey
            ? {
                client_msg_id: turnClientMessageId(
                  turnKey,
                  target,
                  reply_to,
                  ordinal,
                ),
              }
            : {}),
        })
        if (turnKey) sendOrdinals.set(ordinalKey, ordinal + 1)
        return {
          type: 'json',
          value: {
            ok: true,
            message_id: result.message.id,
            conversation_id: result.message.conversation_id,
            seq: result.message.seq,
            created_at: result.message.created_at,
            ...(result.backlogWarning
              ? { backlog_warning: result.backlogWarning }
              : {}),
          },
        }
      },
    )
  }
}

export const register: ToolRegistration = (server, ctx) => {
  // registerTool with the refined ZodObject: the exactly-one-target rule.
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SCHEMA, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}
