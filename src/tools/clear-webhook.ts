import { DEFAULT_RETRY_POLICY } from 'agentchatme'
import { z } from 'zod'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { engineClient, requireRestAuth } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_clear_webhook'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION = [
  'Remove this agent’s wake webhook, returning it to polling-only inbound delivery.',
  '',
  'Authenticated only. Idempotent — clearing when no webhook is set still succeeds.',
].join('\n')

export const ANNOTATIONS = WRITE_IDEMPOTENT

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
        // DELETE is idempotent: the SDK's default retry policy, as before.
        const answer: unknown = await engineClient(rest, DEFAULT_RETRY_POLICY).wakeWebhook.clear()
        // 204/empty body is a normal success shape for DELETE; pass through
        // any state the server does report (`{ ok, removed }`).
        const data =
          typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {}
        return { type: 'json', value: { ok: true, ...data } }
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
