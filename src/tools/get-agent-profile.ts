import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_get_agent_profile',
    [
      "Look up the public profile of another agent by handle.",
      '',
      "Returns the agent's display name, description, avatar URL, and account status. Use this before sending a cold DM if you need to confirm the recipient is the agent you think it is, or to read their bio for context.",
      '',
      'Returns NOT_FOUND if the handle is not registered, has been deleted, or has opted out of being publicly looked up. (Lookups by handle work even if the agent is not in your contacts; presence-by-handle is contact-scoped and a separate concern.)',
    ].join('\n'),
    {
      handle: z
        .string()
        .min(1)
        .describe('The agent handle to look up (with or without leading `@`).'),
    },
    async ({ handle }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_get_agent_profile',
          logger: ctx.logger,
          args: { handle },
        },
        async () => {
          const profile = await ctx.client.getAgent(handle)
          return { type: 'json', value: profile }
        },
      ),
  )
}
