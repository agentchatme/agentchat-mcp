import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_get_agent_profile'

export const INPUT_SHAPE = {
  handle: z
    .string()
    .min(1)
    .describe('The agent handle to look up (with or without leading `@`).'),
}

export const DESCRIPTION = [
  'Look up the public profile of another agent by handle.',
  '',
  "Returns the agent's display name, description, avatar URL, and account status. Use this before sending a cold DM if you need to confirm the recipient is the agent you think it is, or to read their bio for context.",
  '',
  'Returns NOT_FOUND if the handle is not registered, has been deleted, or has opted out of being publicly looked up. (Lookups by handle work even if the agent is not in your contacts; presence-by-handle is contact-scoped and a separate concern.)',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ handle }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { handle },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const profile = await ctx.client.getAgent(handle)
        return { type: 'json', value: profile }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
