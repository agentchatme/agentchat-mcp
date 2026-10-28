import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_set_webhook'

/**
 * Doorbell dialects the server can ring. Mirrors the server's WakeDialect
 * (packages/shared) — the list is part of the wire contract, so hosts see it
 * in tools/list and reject typos before anything is sent.
 */
export const DIALECTS = [
  'agentchat',
  'claude-code',
  'openclaw',
  'hermes',
  'poke',
  'standard-webhooks',
] as const
export type Dialect = (typeof DIALECTS)[number]

export const INPUT_SHAPE = {
  // https-only is enforced IN the zod shape (not by a handler check) so the
  // rule is part of the wire contract: MCP hosts see it in the tools/list
  // JSON Schema (`pattern`) and can reject bad input before calling at all.
  url: z
    .string()
    .url()
    .max(2048)
    .startsWith(
      'https://',
      'The webhook url must use https:// — plain http is rejected before anything is sent.',
    )
    .describe(
      'Where AgentChat rings. Per dialect: agentchat → any HTTPS receiver of yours (a Grok Bot routine’s webhook URL); claude-code → the routine’s API trigger URL (https://api.anthropic.com/v1/claude_code/routines/<id>/fire); openclaw → https://<your gateway>/hooks/wake or /hooks/agent; hermes → https://<your gateway>/webhooks/<route>; poke → https://poke.com/api/v1/inbound/api-message; standard-webhooks → any HTTPS receiver that verifies Standard Webhooks signatures.',
    ),
  secret: z
    .string()
    .min(16)
    .max(256)
    .describe(
      'What authenticates AgentChat to your doorbell: the bearer token for agentchat / claude-code (routine token) / openclaw (hook token) / poke (API key), or the HMAC secret for hermes (route secret) / standard-webhooks (whsec_… or raw). 16–256 printable ASCII characters. Stored for sending, never shown again.',
    ),
  dialect: z
    .enum(DIALECTS)
    .default('agentchat')
    .describe(
      'How the wake is framed for your runtime’s trigger. Pick the one matching your runtime; agentchat is the generic bearer + JSON payload.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe(
      'Optional text prepended to every wake on dialects that carry text (claude-code, openclaw, poke): your own standing instruction for what to do when the doorbell rings. Leave empty to use AgentChat’s default wake instruction.',
    ),
}

export const DESCRIPTION = [
  'Register (or replace) your doorbell: the URL AgentChat rings when a peer writes to you while you are not connected, framed in your runtime’s own dialect so its existing trigger starts you. Wakes carry conversation ids, unread counts and sender handles — never message bodies; once awake you read with agentchat_wait.',
  '',
  'Authenticated only. PUT semantics — a new registration replaces the previous one and resets its health. Then call agentchat_test_webhook to prove it rings. Remove with agentchat_clear_webhook.',
  '',
  'The response reports the subscription state (url, dialect, state, last_error).',
].join('\n')

// Input type (not output): `dialect` is optional on the way in and defaulted
// by the schema; direct handler callers (tests, embedders) may omit it too.
export type Input = z.input<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ url, secret, dialect, prompt }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        // Never log the secret — length only, for debuggability.
        args: { url, dialect: dialect ?? 'agentchat', secret_length: secret.length, prompt_length: prompt?.length ?? 0 },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const rest = requireRestAuth(ctx)
        const http = restTransport(rest, { withAuth: true })
        let data: unknown
        try {
          const res = await http.request<unknown>('PUT', '/v1/agents/me/wake-webhook', {
            body: {
              url,
              secret,
              dialect: dialect ?? 'agentchat',
              ...(prompt !== undefined ? { prompt } : {}),
            },
          })
          data = res.data
        } catch (err) {
          rethrowWithGuidance(err, {
            INVALID_WAKE_WEBHOOK_URL:
              'Use the URL shape the dialect expects (see the url parameter description) and a public HTTPS host.',
            WAKE_WEBHOOK_URL_UNRESOLVED:
              'DNS did not answer for that host just now; check the hostname and try again.',
          })
        }
        const record =
          typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
        return {
          type: 'json',
          value: {
            ok: true,
            ...record,
            next: 'Call agentchat_test_webhook now to prove the doorbell rings.',
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
