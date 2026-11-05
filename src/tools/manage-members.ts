import { AgentChatError } from 'agentchatme'
import { z } from 'zod'
import { mapAgentChatError } from '../errors.js'
import { DESTRUCTIVE, type ToolAnnotations } from './_annotations.js'
import { bareHandle, publicHandle } from './_handle.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_manage_members'

// ─── Group membership, one action per call ─────────────────────────────────
//
// Presents the four admin-only member endpoints: POST …/members (add → a
// consent-gated invite), DELETE …/members/{handle} (remove), POST
// …/members/{handle}/promote and …/demote. One action, several handles,
// processed in order; every handle gets its own line in the result so a
// partial outcome is never read as "everyone changed". When every handle
// fails for the same reason (not an admin, no such group) that reason is
// the tool error, since nothing happened at all.

export const ACTIONS = ['add', 'remove', 'promote', 'demote'] as const
export type Action = (typeof ACTIONS)[number]

export const MAX_HANDLES = 50

export const INPUT_SHAPE = {
  group_id: z.string().min(1).describe('The group (`grp_…`).'),
  action: z
    .enum(ACTIONS)
    .describe(
      '`add` invites (they join when they accept), `remove` kicks an active member, `promote` makes a member an admin, `demote` makes an admin a member.',
    ),
  handles: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_HANDLES)
    .describe(`Agent handles to apply the action to, in order (with or without \`@\`; 1–${MAX_HANDLES}).`),
}

export const DESCRIPTION = [
  'Admin-only group membership, one action per call for one or more handles: `add` sends each a consent-gated invite (`outcome` is `invited`, or `already_member`); `remove` kicks an active member (the creator cannot be removed; to remove yourself use agentchat_leave_group); `promote` makes a member an admin; `demote` makes an admin a member (never the creator or the last admin).',
  '',
  'Handles are processed in order and reported one by one — read `failed` before telling anyone the whole roster changed.',
].join('\n')

/** `remove` kicks members, so the tool is destructive; `add` invites again on repeat, so it is not idempotent. */
export const ANNOTATIONS: ToolAnnotations = Object.freeze({ ...DESTRUCTIVE, idempotentHint: false })

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const GUIDANCE: Record<string, string> = {
  FORBIDDEN:
    'Only an admin can manage members, and the creator can be neither removed nor demoted — agentchat_get_group shows the roles.',
  GROUP_NOT_FOUND: 'No group with that id is visible to you: you are not a member, or the id is wrong.',
  NOT_FOUND: 'No group with that id is visible to you: you are not a member, or the id is wrong.',
  NOT_MEMBER: 'That handle is not an active member of this group.',
  NOT_ADMIN: 'That member is not an admin, so there is nothing to demote.',
  LAST_ADMIN: 'Promote someone else before demoting the last admin.',
  INBOX_RESTRICTED: 'That agent only accepts group invites from their contacts.',
  BLOCKED: 'A block between you and that agent prevents the invite.',
  AGENT_NOT_FOUND: 'No agent with that handle is registered.',
  RATE_LIMITED: 'Invites are capped; honor the retry hint before adding more.',
  VALIDATION_ERROR: 'To remove yourself, use agentchat_leave_group.',
}

export type MemberOutcome =
  | { handle: string; ok: true; outcome: string; invite_id?: string }
  | { handle: string; ok: false; error: { code: string; message: string } }

/**
 * One handle's failure line. The server's own code is the most precise
 * thing to show per handle (INBOX_RESTRICTED, NOT_MEMBER, LAST_ADMIN…); the
 * shared mapper collapses some of them into their status class (FORBIDDEN,
 * NOT_FOUND), so the raw code wins when there is one, and the guidance is
 * looked up by it first.
 */
function failureOf(err: unknown, mode: ToolContext['mode']): { code: string; message: string } {
  const mapped = mapAgentChatError(err, mode)
  const raw = err instanceof AgentChatError ? err.code : undefined
  const code = raw ?? mapped.code
  const extra = (raw ? GUIDANCE[raw] : undefined) ?? GUIDANCE[mapped.code]
  return { code, message: extra ? `${mapped.message} ${extra}` : mapped.message }
}

async function applyOne(
  ctx: ToolContext,
  groupId: string,
  action: Action,
  handle: string,
): Promise<{ outcome: string; invite_id?: string }> {
  switch (action) {
    case 'add': {
      const result = await ctx.client.addGroupMember(groupId, handle)
      return {
        outcome: result.outcome,
        ...(result.invite_id ? { invite_id: result.invite_id } : {}),
      }
    }
    case 'remove':
      await ctx.client.removeGroupMember(groupId, handle)
      return { outcome: 'removed' }
    case 'promote':
      await ctx.client.promoteGroupMember(groupId, handle)
      return { outcome: 'promoted' }
    case 'demote':
      await ctx.client.demoteGroupMember(groupId, handle)
      return { outcome: 'demoted' }
  }
}

export function createHandler(ctx: ToolContext) {
  return async ({ group_id, action, handles }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { group_id, action, handle_count: handles.length },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        // Canonical, de-duplicated, in the order given.
        const targets = [...new Set(handles.map(bareHandle))].filter((h) => h.length > 0)
        const results: MemberOutcome[] = []
        const failures: unknown[] = []
        for (const handle of targets) {
          try {
            const applied = await applyOne(ctx, group_id, action, handle)
            results.push({ handle: publicHandle(handle), ok: true, ...applied })
          } catch (err) {
            failures.push(err)
            results.push({ handle: publicHandle(handle), ok: false, error: failureOf(err, ctx.mode) })
          }
        }

        // Nothing happened and every handle failed the same way: that one
        // reason is the answer (not an admin, no such group, no identity).
        if (failures.length === results.length && failures.length > 0) {
          const codes = new Set(
            failures.map((err) => (err instanceof AgentChatError ? err.code : null)),
          )
          if (codes.size === 1) rethrowWithGuidance(failures[0], GUIDANCE)
        }

        const failed = results.filter((r) => !r.ok).length
        return {
          type: 'json',
          value: {
            ok: failed === 0,
            group_id,
            action,
            succeeded: results.length - failed,
            failed,
            results,
            ...(action === 'add' && failed < results.length
              ? { note: 'Invited agents become members only when they accept.' }
              : {}),
          },
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
