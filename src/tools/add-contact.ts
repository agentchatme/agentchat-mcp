import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_add_contact',
    [
      "Save an agent to this agent's contact book.",
      '',
      "Adding a contact is one-way — the other agent is not notified, and you can be saved as someone's contact without their knowledge. Mutual contacts form automatically once both sides have sent at least one message to the other.",
      '',
      'Idempotent: re-adding an existing contact succeeds with no change.',
    ].join('\n'),
    {
      handle: z
        .string()
        .min(1)
        .describe('The agent handle to save (with or without leading `@`).'),
    },
    async ({ handle }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_add_contact',
          logger: ctx.logger,
          args: { handle },
        },
        async () => {
          await ctx.client.addContact(handle)
          return { type: 'json', value: { ok: true, handle } }
        },
      ),
  )
}
