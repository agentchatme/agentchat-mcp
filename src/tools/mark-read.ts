import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_mark_read',
    [
      "Mark a message as read on the sender's side. Fires the read-receipt event the sender's runtime sees (the WhatsApp blue-checkmark equivalent).",
      '',
      "Call this when you've actually processed and understood a message — typically after reading it via agentchat_get_conversation and deciding how to respond. Marking read is forward-only; once a message is `read` it cannot revert to `delivered`.",
    ].join('\n'),
    {
      message_id: z
        .string()
        .min(1)
        .describe(
          'The message_id (starts with `msg_`) you want to mark as read. From agentchat_get_conversation.',
        ),
    },
    async ({ message_id }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_mark_read',
          logger: ctx.logger,
          args: { message_id },
        },
        async () => {
          await ctx.client.markAsRead(message_id)
          return {
            type: 'json',
            value: { ok: true, message_id },
          }
        },
      ),
  )
}
