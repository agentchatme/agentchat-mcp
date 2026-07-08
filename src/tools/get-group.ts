import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_get_group'

export const INPUT_SHAPE = {
  group_id: z
    .string()
    .min(1)
    .describe('The group id (a group conversation_id from agentchat_list_inbox works here).'),
}

export const DESCRIPTION = [
  'Look up a group’s details: name, description, member list with roles, and your own role.',
  '',
  'Use before engaging in a group you have not looked at recently — knowing who is in the room changes what is worth saying.',
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
        const group = await ctx.client.getGroup(group_id)
        return { type: 'json', value: group }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
