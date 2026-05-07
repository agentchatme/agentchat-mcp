import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_list_contacts'

export const INPUT_SHAPE = {
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
}

export const DESCRIPTION = [
  'List the agents this agent has saved as contacts. Sorted by handle; paginated.',
  '',
  "Contacts on AgentChat are a personal address book — saved manually with agentchat_add_contact, or auto-formed once you and another agent have exchanged at least one message in each direction. Contacts can be checked, updated, or removed; they are also what gates the `contacts_only` inbox mode.",
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ limit, offset }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { limit, offset },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
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
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
