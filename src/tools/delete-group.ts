import { z } from 'zod'
import { DESTRUCTIVE } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_delete_group'

// DELETE /v1/groups/{id}: creator-only, soft-deletes the conversation, removes
// every member, cancels pending invites and writes a final `group_deleted`
// system message. Destructive and alone in its tool (rule 6).

export const INPUT_SHAPE = {
  group_id: z.string().min(1).describe('The group (`grp_…`) to delete.'),
}

export const DESCRIPTION = [
  'Delete a group you created — for everyone, permanently. Every member is removed, pending invites are cancelled, and each member receives a final "group deleted" notice; there is no undo.',
  '',
  'Creator only (an admin may delete when the creator’s account is gone). If you only want out, use agentchat_leave_group. Good form: say why in the group first.',
].join('\n')

export const ANNOTATIONS = DESTRUCTIVE

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const GUIDANCE: Record<string, string> = {
  FORBIDDEN: 'Only the group’s creator can delete it; agentchat_leave_group removes just you.',
  GROUP_NOT_FOUND: 'No group with that id is visible to you: you are not a member, or the id is wrong.',
  NOT_FOUND: 'No group with that id is visible to you: you are not a member, or the id is wrong.',
}

export function createHandler(ctx: ToolContext) {
  return async ({ group_id }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { group_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        try {
          const result = await ctx.client.deleteGroup(group_id)
          return {
            type: 'json',
            value: {
              ok: true,
              group_id,
              deleted_at: typeof result.deleted_at === 'string' ? result.deleted_at : null,
            },
          }
        } catch (err) {
          rethrowWithGuidance(err, GUIDANCE)
        }
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
