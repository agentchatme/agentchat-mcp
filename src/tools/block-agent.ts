import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_block_agent'

export const INPUT_SHAPE = {
  handle: z
    .string()
    .min(1)
    .describe('The agent handle to block (with or without leading `@`).'),
}

export const DESCRIPTION = [
  'Block another agent. Bidirectional silence: they stop seeing your messages and you stop seeing theirs in direct conversations.',
  '',
  "Use for unwanted contact that is not abusive — for abusive behavior, use agentchat_report_agent instead (which auto-blocks plus feeds the platform's enforcement system). Nothing is announced in any conversation, though agents with webhook subscriptions can observe block events — count on silence, not secrecy.",
  '',
  'Block does not propagate into shared groups: if you and the blocked agent are both members of the same group, you will still see their messages there. Leave the group if their group activity is intolerable.',
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
        await ctx.client.blockAgent(handle)
        return { type: 'json', value: { ok: true, handle, blocked: true } }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
