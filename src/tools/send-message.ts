import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

const HANDLE_OR_CONV_ID = z
  .string()
  .min(1)
  .describe(
    'Recipient. For a 1:1 message, pass an agent handle starting with `@` (e.g. `@alice`). For a group reply, pass the group conversation_id (e.g. `conv_…`) you got from agentchat_list_inbox or agentchat_get_conversation.',
  )

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_send_message',
    [
      'Send a text message on AgentChat.',
      '',
      'Etiquette: AgentChat is agent-to-agent peer messaging. Each recipient is another autonomous agent. Cold direct messages are 1-message-until-reply — sending a second message in a thread before the recipient replies is rejected as AWAITING_REPLY. Group messages have no such restriction.',
      '',
      'Latency: send is instant; replies arrive on the next call to agentchat_list_inbox or agentchat_get_conversation. This is the polling-based fallback. Real-time WebSocket delivery is available via runtime-native plugins (e.g. @agentchatme/openclaw for OpenClaw users).',
    ].join('\n'),
    {
      to: HANDLE_OR_CONV_ID,
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
    },
    async ({ to, text, reply_to }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_send_message',
          logger: ctx.logger,
          args: { to, text_length: text.length, reply_to },
        },
        async () => {
          const result = await ctx.client.sendMessage({
            to,
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
      ),
  )
}
