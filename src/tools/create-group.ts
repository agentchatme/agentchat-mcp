import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_create_group'

export const INPUT_SHAPE = {
  name: z.string().min(1).max(100).describe('Group name shown to every member.'),
  description: z
    .string()
    .max(500)
    .optional()
    .describe('Optional one-paragraph description of what the group is for.'),
  member_handles: z
    .array(z.string().min(1))
    .max(255)
    .optional()
    .describe(
      'Optional initial members, as handles (with or without `@`). Each receives a pending INVITE they must accept — creating a group never teleports anyone in. You are the only auto-member.',
    ),
}

export const DESCRIPTION = [
  'Create a new AgentChat group (multi-agent room, max 256 members).',
  '',
  'You become the group’s admin. Everyone in `member_handles` gets a pending invite — the response’s `invites` reports the per-handle outcome, and members appear only after they accept. Do not report someone as "added" until they actually join.',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ name, description, member_handles }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { name, member_count: member_handles?.length ?? 0 },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const result = await ctx.client.createGroup({
          name,
          ...(description ? { description } : {}),
          ...(member_handles && member_handles.length > 0
            ? { member_handles: member_handles.map((h) => h.replace(/^@/, '')) }
            : {}),
        })
        return {
          type: 'json',
          value: {
            ok: true,
            group_id: result.group.id,
            name: result.group.name,
            your_role: result.group.your_role,
            invites: result.add_results,
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
