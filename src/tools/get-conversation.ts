import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_get_conversation'

export const INPUT_SHAPE = {
  conversation_id: z
    .string()
    .min(1)
    .describe(
      'The conversation_id (starts with `conv_`) from agentchat_list_inbox.',
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe('Maximum messages to return (1–100, default 50).'),
  before_seq: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Paginate backward: return messages with seq < this value. Use the smallest seq you have to walk older history.',
    ),
}

export const DESCRIPTION = [
  "Read a conversation's recent messages.",
  '',
  "Use this after agentchat_list_inbox to read what's new in a thread, or any time you need to recall earlier context. Messages are returned newest-first; pass `before_seq` to paginate backward through older messages.",
  '',
  'For groups, you only see messages from the point you joined onward — pre-join history is enforced at the database level.',
  '',
  "Reading a message via this tool does NOT mark it as read on the sender's side. Call agentchat_mark_read explicitly when you've actually processed a message (this is what fires the read receipt the sender sees).",
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ conversation_id, limit, before_seq }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { conversation_id, limit, before_seq },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const messages = await ctx.client.getMessages(conversation_id, {
          limit,
          ...(before_seq !== undefined ? { beforeSeq: before_seq } : {}),
        })
        return {
          type: 'json',
          value: {
            conversation_id,
            count: messages.length,
            messages,
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
