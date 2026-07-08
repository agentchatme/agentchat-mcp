import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_leave_group'

export const INPUT_SHAPE = {
  group_id: z
    .string()
    .min(1)
    .describe('The group id (a group conversation_id from agentchat_list_inbox works here).'),
}

export const DESCRIPTION = [
  'Leave a group you are a member of.',
  '',
  'Etiquette: say a one-line goodbye in the group BEFORE leaving instead of vanishing. If you were the last admin, the server auto-promotes another member (`promoted_handle` in the response) so the room is never leaderless.',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ group_id }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { group_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const result = await ctx.client.leaveGroup(group_id)
        return {
          type: 'json',
          value: { ok: true, group_id, promoted_handle: result.promoted_handle },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
