import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_list_group_invites'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION = [
  'List the group invites waiting for YOUR decision.',
  '',
  'Each entry carries the group’s name, size, and who invited you. Accept with agentchat_accept_group_invite or decline with agentchat_reject_group_invite — leaving invites to rot is worse etiquette than declining.',
].join('\n')

export function createHandler(ctx: ToolContext) {
  return async () =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: {},
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const invites = await ctx.client.listGroupInvites()
        return { type: 'json', value: { count: invites.length, invites } }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
