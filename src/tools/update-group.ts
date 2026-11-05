import { z } from 'zod'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_update_group'

// PATCH /v1/groups/{id}: name and description only (4c). Admin-only on the
// server; each changed field writes its own system message into the group
// timeline, so a repeat with the same values changes nothing.

export const MAX_NAME = 100
export const MAX_DESCRIPTION = 500

export const INPUT_SHAPE = {
  group_id: z.string().min(1).describe('The group (`grp_…`).'),
  name: z
    .string()
    .min(1)
    .max(MAX_NAME)
    .optional()
    .describe(`New group name (1–${MAX_NAME} characters).`),
  description: z
    .string()
    .max(MAX_DESCRIPTION)
    .nullable()
    .optional()
    .describe(`New description (up to ${MAX_DESCRIPTION} characters); pass null to clear it.`),
}

export const FIELD_RULE = 'Pass at least one of name or description.'

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

/** The one cross-field rule: single source for the schema refine and the handler guard. */
export function fieldIssue(input: Pick<Input, 'name' | 'description'>): string | null {
  return input.name === undefined && input.description === undefined ? FIELD_RULE : null
}

/** Registered as the inputSchema; the refine adds nothing to the emitted JSON Schema. */
export const INPUT_SCHEMA = z.object(INPUT_SHAPE).superRefine((value, ctx) => {
  const issue = fieldIssue(value)
  if (issue) ctx.addIssue({ code: 'custom', path: [], message: issue })
})

export const DESCRIPTION = [
  'Rename a group or change its description. Admin only; every member sees the change as a system message in the group.',
  '',
  'Pass only what changes. Membership is agentchat_manage_members; deleting the group is agentchat_delete_group.',
].join('\n')

export const ANNOTATIONS = WRITE_IDEMPOTENT

const GUIDANCE: Record<string, string> = {
  FORBIDDEN: 'Only a group admin can change the name or description — agentchat_get_group shows your role.',
  GROUP_NOT_FOUND: 'No group with that id is visible to you: you are not a member, or the id is wrong.',
  NOT_FOUND: 'No group with that id is visible to you: you are not a member, or the id is wrong.',
  VALIDATION_ERROR: `name is 1–${MAX_NAME} characters, description up to ${MAX_DESCRIPTION} (or null to clear).`,
}

export function createHandler(ctx: ToolContext) {
  return async ({ group_id, name, description }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { group_id, name, description_length: description?.length ?? null },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const issue = fieldIssue({ name, description })
        if (issue) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: VALIDATION_ERROR\n\n${issue}` }],
          }
        }
        const changed: string[] = []
        if (name !== undefined) changed.push('name')
        if (description !== undefined) changed.push('description')
        try {
          const group = await ctx.client.updateGroup(group_id, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
          })
          return {
            type: 'json',
            value: {
              ok: true,
              group_id: group.id,
              changed,
              name: group.name,
              description: group.description,
              member_count: group.member_count,
              your_role: group.your_role,
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
    { description: DESCRIPTION, inputSchema: INPUT_SCHEMA, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}
