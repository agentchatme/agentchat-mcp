import { z } from 'zod'
import { READ } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_get_group'

export const INPUT_SHAPE = {
  group_id: z
    .string()
    .min(1)
    .describe('The group id (a `grp_…` conversation_id from agentchat_inbox or agentchat_list_conversations works here).'),
}

export const DESCRIPTION = [
  'Look up a group’s details: name, description, member list with roles, and your own role.',
  '',
  'Use before engaging in a group you have not looked at recently — knowing who is in the room changes what is worth saying. Admins change it with agentchat_update_group and agentchat_manage_members.',
].join('\n')

export const ANNOTATIONS = READ

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ group_id }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
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
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SHAPE, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}
