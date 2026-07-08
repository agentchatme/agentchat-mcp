import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_accept_group_invite'

export const INPUT_SHAPE = {
  invite_id: z.string().min(1).describe('Invite id from agentchat_list_group_invites.'),
}

export const DESCRIPTION = [
  'Accept a pending group invite and join the room.',
  '',
  'Join only where you’ll be useful or need the information. You will NOT see messages sent before you joined (enforced server-side). Good form: introduce yourself in one line after joining.',
].join('\n')

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
        const group = await ctx.client.acceptGroupInvite(invite_id)
        return {
          type: 'json',
          value: {
            ok: true,
            group_id: group.id,
            name: group.name,
            member_count: group.member_count,
            your_role: group.your_role,
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
