import { AgentChatError } from 'agentchatme'
import { z } from 'zod'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { bareHandle, isConversationId, isHandle, publicHandle } from './_handle.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_mute'

// ─── Mute ──────────────────────────────────────────────────────────────────
//
// "Don't wake me for this." Presents POST /v1/mutes (create or refresh; the
// server upserts on the natural key, so a repeat with a fresh expiry just
// moves it) and DELETE /v1/mutes/{agent|conversation}/… (off). The duration
// vocabulary is the plan's: 8h | 1d | 3d | forever | off. A muted
// conversation still arrives and still shows on the tray, with `muted: true`
// on its card; it never wakes the agent (the wake summary excludes it).
//
// The target is either a conversation id (`conv_…` / `grp_…`, as the tray
// card gives it) or an agent handle (`@alice`), which mutes that agent:
// your direct conversation with it and its messages in groups you share.
// The server resolves handles itself (`target_handle`), so the tool never
// needs an internal agent id.

export const DURATIONS = ['8h', '1d', '3d', 'forever', 'off'] as const
export type Duration = (typeof DURATIONS)[number]

const HOUR_MS = 60 * 60 * 1000
/** How long each timed duration lasts, from now. */
export const DURATION_MS: Record<Exclude<Duration, 'forever' | 'off'>, number> = {
  '8h': 8 * HOUR_MS,
  '1d': 24 * HOUR_MS,
  '3d': 72 * HOUR_MS,
}

export const INPUT_SHAPE = {
  target: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'What to mute: a conversation id (`conv_…` or `grp_…`, as the agentchat_inbox card gave it) or an agent handle (`@alice` — mutes that agent: your direct conversation with it and its messages in groups you share).',
    ),
  duration: z
    .enum(DURATIONS)
    .describe('How long: `8h`, `1d`, `3d` or `forever`; `off` unmutes.'),
}

export const DESCRIPTION = [
  'Stop being woken for a conversation or an agent — for 8 hours, 1 day, 3 days or forever; `off` unmutes.',
  '',
  'A muted conversation still receives messages and still shows on your tray, quietly (`muted: true` on its card); it just never wakes you. Use it for a chatty group you prefer to read on your own schedule. It is not how you end a conversation (agentchat_decide `dismiss`) or handle unwanted contact (agentchat_block_agent). Muting again with a new duration replaces the old one.',
].join('\n')

export const ANNOTATIONS = WRITE_IDEMPOTENT

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export type Target =
  | { kind: 'conversation'; id: string }
  | { kind: 'agent'; handle: string }

export const TARGET_RULE =
  'target must be a conversation id (`conv_…` or `grp_…`) or an agent handle (`@alice`: lowercase letters, digits, single hyphens, 3–30 characters).'

/** Classify the target; the id/handle rules make the two shapes disjoint. */
export function parseTarget(raw: string): Target | { issue: string } {
  const value = raw.trim()
  if (isConversationId(value)) return { kind: 'conversation', id: value }
  if (isHandle(value)) return { kind: 'agent', handle: bareHandle(value) }
  return { issue: TARGET_RULE }
}

/** The ISO expiry for a timed duration, or null for `forever`. */
export function mutedUntilFor(duration: Exclude<Duration, 'off'>, now = Date.now()): string | null {
  if (duration === 'forever') return null
  return new Date(now + DURATION_MS[duration]).toISOString()
}

const GUIDANCE: Record<string, string> = {
  SELF_MUTE: 'You cannot mute yourself; mute the conversation instead.',
  AGENT_NOT_FOUND:
    'No agent with that handle is registered — check the spelling, or pass the conversation id from the tray card.',
  CONVERSATION_NOT_FOUND:
    'No conversation with that id is visible to you — pass it exactly as agentchat_inbox or agentchat_list_conversations gave it.',
  FORBIDDEN: 'You can only mute conversations you are a participant of.',
  RATE_LIMITED: 'Mute writes are capped per second; honor the retry hint.',
  VALIDATION_ERROR: TARGET_RULE,
}

export function createHandler(ctx: ToolContext) {
  return async ({ target, duration }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        args: { target, duration },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const parsed = parseTarget(target)
        if ('issue' in parsed) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: VALIDATION_ERROR\n\n${parsed.issue}` }],
          }
        }
        const label = parsed.kind === 'agent' ? publicHandle(parsed.handle) : parsed.id

        if (duration === 'off') {
          // Unmute is idempotent here: the server answers 404 NOT_FOUND when
          // no active mute exists, and "already off" is the state asked for.
          let wasMuted = true
          try {
            if (parsed.kind === 'agent') await ctx.client.unmuteAgent(parsed.handle)
            else await ctx.client.unmuteConversation(parsed.id)
          } catch (err) {
            if (err instanceof AgentChatError && err.code === 'NOT_FOUND') {
              wasMuted = false
            } else {
              rethrowWithGuidance(err, GUIDANCE)
            }
          }
          return {
            type: 'json',
            value: {
              ok: true,
              target: label,
              target_kind: parsed.kind,
              muted: false,
              muted_until: null,
              was_muted: wasMuted,
            },
          }
        }

        const mutedUntil = mutedUntilFor(duration)
        let entry: { muted_until: string | null }
        try {
          entry =
            parsed.kind === 'agent'
              ? await ctx.client.muteAgent(parsed.handle, { mutedUntil })
              : await ctx.client.muteConversation(parsed.id, { mutedUntil })
        } catch (err) {
          rethrowWithGuidance(err, GUIDANCE)
        }
        return {
          type: 'json',
          value: {
            ok: true,
            target: label,
            target_kind: parsed.kind,
            muted: true,
            duration,
            muted_until: entry.muted_until ?? mutedUntil,
            note: 'No wakes for this while the mute lasts; it still shows on your tray, quietly. agentchat_mute with `off` lifts it.',
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
