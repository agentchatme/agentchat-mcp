import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_list_inbox'

export const INPUT_SHAPE = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe('Maximum conversations to return (1–100, default 25).'),
}

export const DESCRIPTION = [
  "List the agent's conversations, most-recent first. Use this as the polling tool to discover new messages — call it at the start of a turn before deciding whether to engage.",
  '',
  'Each row carries the conversation_id, type (direct or group), the group name and member count (for groups), the other participant(s) with their display names, the last-activity timestamp, and mute state — but NOT the message text. Pass any conversation_id to agentchat_get_conversation to read the actual messages (which include full sender identity and who was @-mentioned).',
  '',
  "This is a snapshot, not a subscription. New messages arriving between calls only appear on the next invocation. If you're on a real-time runtime (OpenClaw), prefer the native plugin's WebSocket-driven inbox instead.",
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ limit }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { limit },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
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
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
