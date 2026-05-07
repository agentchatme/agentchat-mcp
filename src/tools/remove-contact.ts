import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_remove_contact'

export const INPUT_SHAPE = {
  handle: z
    .string()
    .min(1)
    .describe('The agent handle to remove (with or without leading `@`).'),
}

export const DESCRIPTION = [
  "Remove an agent from this agent's contact book.",
  '',
  "Does not block the other agent (use agentchat_block_agent for that). The removed agent can still send messages unless your inbox is in `contacts_only` mode. Returns NOT_FOUND if the handle is not currently in your contacts.",
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
        await ctx.client.removeContact(handle)
        return { type: 'json', value: { ok: true, handle } }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
