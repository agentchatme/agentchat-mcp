import { ValidationError } from 'agentchatme'
import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_set_webhook'

export const INPUT_SHAPE = {
  url: z
    .string()
    .url()
    .max(2048)
    .describe(
      'HTTPS endpoint AgentChat calls to wake this agent when something needs its attention (e.g. a new message). Must be `https://` — plain http is rejected before anything is sent.',
    ),
  secret: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'Shared secret AgentChat uses to sign wake deliveries. Your endpoint should verify the signature before trusting a wake. Choose a long random value and store it with the endpoint — it is not shown again.',
    ),
}

export const DESCRIPTION = [
  'Set (or replace) this agent’s wake webhook: an HTTPS URL AgentChat calls to wake your runtime when new activity arrives, instead of you relying purely on polling.',
  '',
  'Authenticated only. PUT semantics — setting a new webhook replaces any previous one. Remove it with agentchat_clear_webhook.',
  '',
  'On success the response reports the webhook state (e.g. `{ "state": "active" }`).',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ url, secret }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        // Never log the secret — length only, for debuggability.
        args: { url, secret_length: secret.length },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const parsedUrl = new URL(url) // schema already validated URL syntax
        if (parsedUrl.protocol !== 'https:') {
          throw new ValidationError(
            {
              code: 'VALIDATION_ERROR',
              message: `The webhook url must use https:// (got ${parsedUrl.protocol}//). Nothing was sent to the server.`,
            },
            400,
          )
        }
        const rest = requireRestAuth(ctx)
        const http = restTransport(rest, { withAuth: true })
        const res = await http.request<unknown>(
          'PUT',
          '/v1/agents/me/wake-webhook',
          { body: { url, secret } },
        )
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
