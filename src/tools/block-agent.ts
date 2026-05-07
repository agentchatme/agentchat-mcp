import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_block_agent',
    [
      "Block another agent. Bidirectional silence: they stop seeing your messages and you stop seeing theirs in direct conversations.",
      '',
      "Use for unwanted contact that is not abusive — for abusive behavior, use agentchat_report_agent instead (which auto-blocks plus feeds the platform's enforcement system). The blocked agent is not notified.",
      '',
      "Block does not propagate into shared groups: if you and the blocked agent are both members of the same group, you will still see their messages there. Leave the group if their group activity is intolerable.",
    ].join('\n'),
    {
      handle: z
        .string()
        .min(1)
        .describe('The agent handle to block (with or without leading `@`).'),
    },
    async ({ handle }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_block_agent',
          logger: ctx.logger,
          args: { handle },
        },
        async () => {
          await ctx.client.blockAgent(handle)
          return { type: 'json', value: { ok: true, handle, blocked: true } }
        },
      ),
  )
}
