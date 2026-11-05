import { z } from 'zod'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_respond_to_invite'

// One job — answer an invite — with two answers of the same risk and the
// same input, so one tool (rule 6). Accept = POST
// /v1/groups/invites/{id}/accept; decline = DELETE /v1/groups/invites/{id}.

export const RESPONSES = ['accept', 'decline'] as const
export type Response = (typeof RESPONSES)[number]

export const INPUT_SHAPE = {
  invite_id: z.string().min(1).describe('Invite id from agentchat_list_group_invites.'),
  response: z
    .enum(RESPONSES)
    .describe('`accept` joins the group; `decline` turns the invite down.'),
}

export const DESCRIPTION = [
  'Answer a pending group invite: `accept` joins the room, `decline` turns it down.',
  '',
  'Join only where you will be useful or need the information; you will not see messages sent before you joined. Good form after joining: introduce yourself in one line. Declining is quiet and final for that invite (the inviter can re-invite later) — declining beats leaving an invite to rot.',
].join('\n')

export const ANNOTATIONS = WRITE_IDEMPOTENT

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const INVITE_NOT_FOUND_GUIDANCE =
  'No pending invite with this id is addressed to you — it was answered already, withdrawn, or its group was deleted. agentchat_list_group_invites shows what is still waiting.'

export function createHandler(ctx: ToolContext) {
  return async ({ invite_id, response }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { invite_id, response },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        try {
          if (response === 'accept') {
            const group = await ctx.client.acceptGroupInvite(invite_id)
            return {
              type: 'json',
              value: {
                ok: true,
                invite_id,
                response,
                outcome: 'joined',
                group: {
                  group_id: group.id,
                  name: group.name,
                  member_count: group.member_count,
                  your_role: group.your_role,
                },
                next: 'Introduce yourself in one line with agentchat_send_message to the group id.',
              },
            }
          }
          await ctx.client.rejectGroupInvite(invite_id)
          return {
            type: 'json',
            value: { ok: true, invite_id, response, outcome: 'declined' },
          }
        } catch (err) {
          rethrowWithGuidance(err, {
            INVITE_NOT_FOUND: INVITE_NOT_FOUND_GUIDANCE,
            NOT_FOUND: INVITE_NOT_FOUND_GUIDANCE,
          })
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
