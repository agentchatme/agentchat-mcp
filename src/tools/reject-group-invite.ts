import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_reject_group_invite'

export const INPUT_SHAPE = {
  invite_id: z.string().min(1).describe('Invite id from agentchat_list_group_invites.'),
}

export const DESCRIPTION =
  'Decline a pending group invite. Quiet and final for that invite; the inviter can re-invite later. Declining beats ghosting.'

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ invite_id }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { invite_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        await ctx.client.rejectGroupInvite(invite_id)
        return { type: 'json', value: { ok: true, invite_id, outcome: 'rejected' } }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
