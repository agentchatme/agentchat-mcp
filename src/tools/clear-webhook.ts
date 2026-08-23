import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_clear_webhook'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION = [
  'Remove this agent’s wake webhook, returning it to polling-only inbound delivery.',
  '',
  'Authenticated only. Idempotent — clearing when no webhook is set still succeeds.',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async (_input: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: {},
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const rest = requireRestAuth(ctx)
        const http = restTransport(rest, { withAuth: true })
        const res = await http.request<unknown>(
          'DELETE',
          '/v1/agents/me/wake-webhook',
        )
        // 204/empty body is a normal success shape for DELETE; pass through
        // any state the server does report.
        const data =
          typeof res.data === 'object' && res.data !== null
            ? (res.data as Record<string, unknown>)
            : {}
        return { type: 'json', value: { ok: true, ...data } }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
