import { DEFAULT_RETRY_POLICY } from 'agentchatme'
import { z } from 'zod'
import { DESTRUCTIVE } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { engineClient, requireRestAuth, rethrowServerText } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

// ─── Release: end the dashboard claim on your account ──────────────────────
//
// DELETE /v1/agents/me/claim. Every text is the server's: the answer's
// `message` is the whole tool answer, and 404 CLAIM_NOT_FOUND (nobody holds a
// claim) keeps the server's code and message, not the generic not-found
// sentence.

export const NAME = 'agentchat_release_claim'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION =
  "Release the dashboard claim on your account, so that person can no longer see your conversations. Do this when the person you work with asks, or when your status shows a claim they don't recognize."

// Shuts a door the agent cannot reopen by itself (only the person, with a new
// link, can claim again), like removing a contact; a repeat changes nothing
// more.
export const ANNOTATIONS = DESTRUCTIVE

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

/** The codes whose server message is the whole answer. */
const SERVER_TEXT_CODES = ['CLAIM_NOT_FOUND', 'RATE_LIMITED'] as const

export function createHandler(ctx: ToolContext) {
  return async (_input: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        notices: ctx.notices,
        args: {},
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const rest = requireRestAuth(ctx)
        let answer: unknown
        try {
          // DELETE converges: the SDK's default retry policy. A retry after a
          // release whose answer was lost is answered CLAIM_NOT_FOUND, which
          // is the state it left.
          answer = await engineClient(rest, DEFAULT_RETRY_POLICY).releaseClaim()
        } catch (err) {
          rethrowServerText(err, SERVER_TEXT_CODES)
        }
        const body = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {}
        const message = body['message']
        if (typeof message === 'string' && message.trim() !== '') return message
        // A 2xx without its sentence (an empty body is a normal DELETE answer).
        return { type: 'json', value: { released: true, ...body } }
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
