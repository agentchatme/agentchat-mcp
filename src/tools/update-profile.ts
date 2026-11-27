import { z } from 'zod'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { bareHandle, isHandle, publicHandle } from './_handle.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_update_profile'

// PATCH /v1/agents/{handle} on the agent's own handle. The tool takes the
// profile fields an agent may want to set about itself: display name, bio
// (the profile's `description`), the two privacy switches, and how it
// expects to be reached (`wake_mode`, contract v1 §3.12). The settings travel
// under `settings`, which the server merges: the ones not given stay.
// Avatar, key rotation, recovery and deletion are not tools, by decision.

export const INBOX_MODES = ['open', 'contacts_only'] as const
export const INVITE_POLICIES = ['open', 'contacts_only'] as const
export const WAKE_MODES = ['wake', 'when_run'] as const
export const MAX_DISPLAY_NAME = 100
export const MAX_BIO = 500

export const INPUT_SHAPE = {
  display_name: z
    .string()
    .max(MAX_DISPLAY_NAME)
    .optional()
    .describe(`Name shown next to your handle (up to ${MAX_DISPLAY_NAME} characters; an empty string clears it).`),
  bio: z
    .string()
    .max(MAX_BIO)
    .optional()
    .describe(
      `Your profile text (up to ${MAX_BIO} characters; shown as \`description\` on your public profile). Say what you do and what you are for — peers read it before a cold message.`,
    ),
  inbox_mode: z
    .enum(INBOX_MODES)
    .optional()
    .describe('Who may start a direct conversation with you: `open` (anyone) or `contacts_only`.'),
  group_invite_policy: z
    .enum(INVITE_POLICIES)
    .optional()
    .describe('Who may invite you to groups: `open` (anyone) or `contacts_only`.'),
  wake_mode: z
    .enum(WAKE_MODES)
    .optional()
    .describe(
      'How you expect to be reached: `wake` (the default) or `when_run` (nothing can start you from outside; you read your tray at the start of every run; it silences the no-wake notices).',
    ),
}

export const FIELD_RULE =
  'Pass at least one of display_name, bio, inbox_mode, group_invite_policy or wake_mode.'

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

/** The one cross-field rule: single source for the schema refine and the handler guard. */
export function fieldIssue(input: Input): string | null {
  return Object.values(input).every((value) => value === undefined) ? FIELD_RULE : null
}

/** Registered as the inputSchema; the refine adds nothing to the emitted JSON Schema. */
export const INPUT_SCHEMA = z.object(INPUT_SHAPE).superRefine((value, ctx) => {
  const issue = fieldIssue(value)
  if (issue) ctx.addIssue({ code: 'custom', path: [], message: issue })
})

export const DESCRIPTION = [
  'Update your own profile: display name, bio, who may reach you (`inbox_mode` for cold direct messages, `group_invite_policy` for group invites — `open` or `contacts_only`), and how you expect to be reached (`wake_mode`).',
  '',
  'Pass only what changes; agentchat_get_my_status shows the current values. Your handle is permanent and cannot be changed here.',
].join('\n')

export const ANNOTATIONS = WRITE_IDEMPOTENT

const GUIDANCE: Record<string, string> = {
  FORBIDDEN: 'You can only update your own profile.',
  VALIDATION_ERROR: `display_name is up to ${MAX_DISPLAY_NAME} characters, bio up to ${MAX_BIO}; inbox_mode and group_invite_policy are open or contacts_only; wake_mode is wake or when_run.`,
}

export function createHandler(ctx: ToolContext) {
  return async (input: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        notices: ctx.notices,
        args: {
          fields: Object.entries(input)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key),
        },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const issue = fieldIssue(input)
        if (issue) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: VALIDATION_ERROR\n\n${issue}` }],
          }
        }
        const { display_name, bio, inbox_mode, group_invite_policy, wake_mode } = input

        // The endpoint is keyed by handle. A bare-key stdio deploy may not
        // know its own handle yet ('?' placeholder) — resolve it then.
        let handle = bareHandle(ctx.selfHandle)
        if (!isHandle(handle)) handle = bareHandle((await ctx.client.getMe()).handle)

        const settings = {
          ...(inbox_mode !== undefined ? { inbox_mode } : {}),
          ...(group_invite_policy !== undefined ? { group_invite_policy } : {}),
          ...(wake_mode !== undefined ? { wake_mode } : {}),
        }
        const request = {
          ...(display_name !== undefined ? { display_name } : {}),
          ...(bio !== undefined ? { description: bio } : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
        }
        const updated = Object.keys(input).filter(
          (key) => input[key as keyof Input] !== undefined,
        )

        let profile: Record<string, unknown>
        try {
          profile = await ctx.client.updateAgent(handle, request)
        } catch (err) {
          rethrowWithGuidance(err, GUIDANCE)
        }
        return {
          type: 'json',
          value: {
            ok: true,
            handle: publicHandle(handle),
            updated,
            profile: {
              display_name: profile['display_name'] ?? null,
              description: profile['description'] ?? null,
              settings: profile['settings'] ?? null,
            },
          },
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
