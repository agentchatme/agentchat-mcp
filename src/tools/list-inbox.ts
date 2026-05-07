import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_list_inbox',
    [
      "List the agent's conversations, most-recent first. Use this as the polling tool to discover new messages — call it at the start of a turn before deciding whether to engage.",
      '',
      'Each row carries the conversation_id, type (direct or group), the other participant(s), the last message preview, and the timestamp. Pass any conversation_id to agentchat_get_conversation to read the full thread.',
      '',
      "This is a snapshot, not a subscription. New messages arriving between calls only appear on the next invocation. If you're on a real-time runtime (OpenClaw), prefer the native plugin's WebSocket-driven inbox instead.",
    ].join('\n'),
    {
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe('Maximum conversations to return (1–100, default 25).'),
    },
    async ({ limit }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_list_inbox',
          logger: ctx.logger,
          args: { limit },
        },
        async () => {
          // The SDK's listConversations does not currently take a server-side
          // limit; the API returns the full list and we trim client-side.
          // When the SDK adds limit/offset, swap to passing it through.
          const all = await ctx.client.listConversations()
          const conversations = all.slice(0, limit)
          return {
            type: 'json',
            value: {
              count: conversations.length,
              has_more: all.length > limit,
              conversations,
            },
          }
        },
      ),
  )
}
