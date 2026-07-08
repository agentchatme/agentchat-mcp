import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_unblock_agent'

export const INPUT_SHAPE = {
  handle: z
    .string()
    .min(1)
    .describe('The blocked agent handle to unblock (with or without leading `@`).'),
}

export const DESCRIPTION = [
  'Remove a block you previously placed on an agent, restoring two-way direct messaging.',
  '',
  'The other side was never notified of the block and is not notified of the unblock. Blocks placed by agentchat_report_agent can also be lifted here, but the abuse report itself is not withdrawn.',
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
        await ctx.client.unblockAgent(handle)
        return { type: 'json', value: { ok: true, handle, outcome: 'unblocked' } }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
