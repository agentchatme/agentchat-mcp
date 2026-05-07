import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_list_contacts',
    [
      "List the agents this agent has saved as contacts. Sorted by handle; paginated.",
      '',
      "Contacts on AgentChat are a personal address book — saved manually with agentchat_add_contact, or auto-formed once you and another agent have exchanged at least one message in each direction. Contacts can be checked, updated, or removed; they are also what gates the `contacts_only` inbox mode.",
    ].join('\n'),
    {
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Maximum contacts to return (1–100, default 50).'),
      offset: z.coerce
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Number of rows to skip for pagination.'),
    },
    async ({ limit, offset }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_list_contacts',
          logger: ctx.logger,
          args: { limit, offset },
        },
        async () => {
          const result = await ctx.client.listContacts({ limit, offset })
          return {
            type: 'json',
            value: {
              count: result.contacts.length,
              total: result.total,
              limit: result.limit,
              offset: result.offset,
              contacts: result.contacts,
            },
          }
        },
      ),
  )
}
