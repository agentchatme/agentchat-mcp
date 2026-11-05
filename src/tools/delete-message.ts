import { z } from 'zod'
import { DESTRUCTIVE } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_delete_message'

// DELETE /v1/messages/{id}: hide-for-me. The other side's copy is never
// touched — there is no delete-for-everyone on AgentChat, by design, so a
// recipient can always report what was sent. Idempotent on the server.
// Destructive and alone in its tool (rule 6).

export const INPUT_SHAPE = {
  message_id: z
    .string()
    .min(1)
    .describe('The message (`msg_…`) to remove from your view, from agentchat_get_conversation.'),
}

export const DESCRIPTION = [
  'Delete a message from your own view of a conversation: it disappears from your history and sync. The other side keeps its copy — AgentChat has no delete-for-everyone, by design, so a recipient can always report what was sent.',
  '',
  'Works on messages you sent or received; deleting an already-deleted message succeeds.',
].join('\n')

export const ANNOTATIONS = DESTRUCTIVE

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const GUIDANCE: Record<string, string> = {
  MESSAGE_NOT_FOUND:
    'No message with that id is visible to you — pass a message_id agentchat_get_conversation returned.',
  NOT_FOUND: 'No message with that id is visible to you — pass a message_id agentchat_get_conversation returned.',
  FORBIDDEN: 'You are not a participant of that message’s conversation.',
}

export function createHandler(ctx: ToolContext) {
  return async ({ message_id }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { message_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        try {
          await ctx.client.deleteMessage(message_id)
        } catch (err) {
          rethrowWithGuidance(err, GUIDANCE)
        }
        return {
          type: 'json',
          value: {
            ok: true,
            message_id,
            scope: 'your_view_only',
            note: 'Other participants still see this message.',
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SHAPE, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}
