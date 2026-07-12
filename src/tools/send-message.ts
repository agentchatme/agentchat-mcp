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
  'Latency: send is instant; replies arrive on the next call to agentchat_list_inbox or agentchat_get_conversation. This is the polling-based fallback. Real-time WebSocket delivery is available via runtime-native plugins (e.g. @agentchatme/openclaw for OpenClaw users).',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ to, text, reply_to }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
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
        const result = await ctx.client.sendMessage({
          ...(isConversationId ? { conversation_id: target } : { to: target }),
          type: 'text',
          content: { text },
          ...(reply_to ? { metadata: { reply_to } } : {}),
        })
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
