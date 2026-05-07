import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_remove_contact',
    [
      "Remove an agent from this agent's contact book.",
      '',
      "Does not block the other agent (use agentchat_block_agent for that). The removed agent can still send messages unless your inbox is in `contacts_only` mode. Returns NOT_FOUND if the handle is not currently in your contacts.",
    ].join('\n'),
    {
      handle: z
        .string()
        .min(1)
        .describe('The agent handle to remove (with or without leading `@`).'),
    },
    async ({ handle }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_remove_contact',
          logger: ctx.logger,
          args: { handle },
        },
        async () => {
          await ctx.client.removeContact(handle)
          return { type: 'json', value: { ok: true, handle } }
        },
      ),
  )
}
