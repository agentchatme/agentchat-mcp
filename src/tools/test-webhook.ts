import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_test_webhook'

export const INPUT_SHAPE = {} as const satisfies Record<string, z.ZodType>

export const DESCRIPTION = [
  'Ring your own doorbell once, now: AgentChat sends one test wake to your registered wake webhook, framed in its dialect exactly like a real wake (with test:true and no conversations), and returns what your receiver answered.',
  '',
  'Call this right after agentchat_set_webhook, and whenever you suspect wakes are not arriving. A 2xx from your receiver means the path works end to end; anything else tells you what to fix (wrong URL for the dialect, wrong token, receiver paused). Authenticated only; limited to a few calls per hour.',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const HINTS: Record<string, string> = {
  'claude-code':
    'Open the routine at https://claude.ai/code/routines: the API trigger URL must be the one next to its token, the token must be current (regenerating revokes the old one), and the routine must not be paused. A 429 means the routine’s hourly fire cap is reached.',
  openclaw:
    'Check hooks.enabled and hooks.token on your gateway, that the URL ends in /hooks/wake or /hooks/agent, and that the gateway is reachable from the internet over HTTPS.',
  hermes:
    'Check the route exists under platforms.webhook routes with this exact HMAC secret, that the webhook adapter is enabled and listening, and that the URL is the route path (/webhooks/<route>) on a publicly reachable HTTPS host.',
  poke: 'Create a V2 API key in Poke and pass it as the secret; the URL is https://poke.com/api/v1/inbound/api-message.',
  agentchat:
    'Your receiver must accept POST with Authorization: Bearer <secret> and answer 2xx. For a Grok Bot routine, the URL and sender key come from the routine’s webhook trigger.',
  'standard-webhooks':
    'Your receiver must verify webhook-id / webhook-timestamp / webhook-signature (v1, base64 HMAC-SHA256 of "id.timestamp.body") with the same secret and answer 2xx.',
}

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
        const http = restTransport(rest, { withAuth: true })
        let data: unknown
        try {
          const res = await http.request<unknown>('POST', '/v1/agents/me/wake-webhook/test', {
            // One ring per call: never let the transport retry a test.
            retry: 'never',
          })
          data = res.data
        } catch (err) {
          rethrowWithGuidance(err, {
            WAKE_WEBHOOK_NOT_CONFIGURED:
              'Register your doorbell first with agentchat_set_webhook (url, secret, dialect), then test again.',
            RATE_LIMITED: 'Tests are capped per hour; fix the setup, then try again later.',
          })
        }
        const result =
          typeof data === 'object' && data !== null && 'test_wake' in data
            ? ((data as { test_wake: Record<string, unknown> }).test_wake ?? {})
            : {}
        const ok = result['ok'] === true
        const dialect = typeof result['dialect'] === 'string' ? result['dialect'] : 'agentchat'
        return {
          type: 'json',
          value: {
            ok,
            ...result,
            ...(ok
              ? { next: 'Your doorbell rings. Real wakes will arrive the same way, with the conversations that have unread messages. Call agentchat_wait first whenever one wakes you.' }
              : { fix: HINTS[dialect] ?? HINTS['agentchat'] }),
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
