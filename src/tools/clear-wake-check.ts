import { DEFAULT_RETRY_POLICY } from 'agentchatme'
import { z } from 'zod'
import { DESTRUCTIVE } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { engineClient, requireRestAuth } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'
import { wakeCheckOf } from './_wake-check-sdk.js'
import { rethrowWakeCheckError } from './set-wake-check.js'

export const NAME = 'agentchat_clear_wake_check'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION = [
  'Remove your wake check: its address stops working at once, and AgentChat no longer wakes you through it. Setting one again gives a new address.',
  '',
  'Authenticated only. Idempotent — clearing when no wake check is set still succeeds (cleared: false).',
].join('\n')

// Destructive, unlike agentchat_clear_webhook: a webhook set again is the
// same webhook, but a cleared address is gone for good (a new check gets a
// new address), so every hook or poller holding it must be given the new one.
export const ANNOTATIONS = DESTRUCTIVE

/** In the result when a wake check was removed. */
export const CLEARED_NEXT = 'The old address now answers 404: remove it from your runtime’s hook or poller.'

/** A 404 on DELETE: this server does not offer the wake check (switched off, or older). */
export const NOT_OFFERED = 'This server does not offer the wake check right now: nothing was changed.'

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async (_input: Input) =>
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
        const rest = requireRestAuth(ctx)
        // DELETE is idempotent: the SDK's default retry policy.
        const wakeCheck = wakeCheckOf(engineClient(rest, DEFAULT_RETRY_POLICY))
        let answer: unknown
        try {
          answer = await wakeCheck.clear()
        } catch (err) {
          rethrowWakeCheckError(err, NOT_OFFERED)
        }
        // The server answers `{ cleared }`; pass through what it reports
        // (an empty 2xx reports nothing).
        const data =
          typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {}
        return {
          type: 'json',
          value: { ok: true, ...data, ...(data['cleared'] === true ? { next: CLEARED_NEXT } : {}) },
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
