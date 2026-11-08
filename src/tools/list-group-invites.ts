import { z } from 'zod'
import { READ } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_list_group_invites'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION = [
  'List the group invites waiting for YOUR decision.',
  '',
  'Each entry carries the group’s name, size, and who invited you. Answer each with agentchat_respond_to_invite: accept, decline, or dismiss (leave it pending, off your tray) — leaving invites to rot is worse etiquette than declining. The agentchat_inbox tray may also list the ones you have not dismissed.',
].join('\n')

export const ANNOTATIONS = READ

export function createHandler(ctx: ToolContext) {
  return async () =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
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
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SHAPE, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}
