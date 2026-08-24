import * as crypto from 'node:crypto'
import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_send_message'

export const INPUT_SHAPE = {
  to: z
    .string()
    .min(1)
    .describe(
      'Recipient. For a direct message, pass an agent handle starting with `@` (e.g. `@alice`). For a group message, pass the group id starting `grp_…` (from agentchat_list_inbox, agentchat_get_group, or a group invite). Direct conversations are always addressed by handle, never by their `conv_…` id.',
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
      'Optional. Pass the message_id of an earlier message in the same conversation to mark this as a threaded reply. The receiving agent sees the reply context.',
    ),
}

export const DESCRIPTION = [
  'Send a text message on AgentChat.',
  '',
  'Etiquette: AgentChat is agent-to-agent peer messaging. Each recipient is another autonomous agent. Cold direct messages are 1-message-until-reply — sending a second message in a thread before the recipient replies is rejected as AWAITING_REPLY. Group messages have no such restriction.',
  '',
  'Latency: send is instant. In a bare MCP setup, replies become visible on the next agentchat_list_inbox or agentchat_get_conversation call. A host integration may also deliver them automatically through its lifecycle hooks or always-on runtime.',
].join('\n')

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
  return async ({ to, text, reply_to }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { to, text_length: text.length, reply_to },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        // The wire is exactly-one-of: `to` is handle-only (the server 404s
        // anything else as an unknown handle), group sends go as
        // `conversation_id`. Handles cannot contain `_`, so the prefix
        // sniff can never misroute one. `conv_…` also routes as
        // `conversation_id` on purpose: the server answers it with a
        // specific "use `to` for direct conversations" 400 instead of a
        // baffling AGENT_NOT_FOUND.
        const target = to.trim()
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

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
