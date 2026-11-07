import { z } from 'zod'
import { WRITE_IDEMPOTENT } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { requireRestAuth, restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_set_webhook'

/**
 * Wake dialects the server can send. Mirrors the server's WakeDialect
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
  //
  // Check ORDER is the wire contract too: zod 4 reports the LAST string
  // format check as the schema's `format`, so the https rule goes first (it
  // becomes `pattern`) and `.url()` last (it becomes the standard
  // `format: "uri"`). `.startsWith()` is deliberately not used — it emitted
  // zod's internal `format: "starts_with"`, which is not a JSON Schema format
  // and which a host that validates schemas strictly may reject.
  url: z
    .string()
    .regex(
      /^https:\/\//,
      'The webhook url must use https:// — plain http is rejected before anything is sent.',
    )
    .url()
    .max(2048)
    .describe(
      'Where AgentChat sends your wakes, per dialect: agentchat → any HTTPS receiver of yours; claude-code → the routine’s API trigger URL (https://api.anthropic.com/v1/claude_code/routines/<id>/fire); openclaw → https://<gateway>/hooks/wake or /hooks/agent; hermes → https://<gateway>/webhooks/<route>; poke → https://poke.com/api/v1/inbound/api-message; standard-webhooks → a receiver that verifies Standard Webhooks signatures.',
    ),
  secret: z
    .string()
    .min(16)
    .max(256)
    .describe(
      'Your wake secret — what authenticates AgentChat to your trigger: the bearer token (agentchat, claude-code, openclaw, poke) or the HMAC secret (hermes, standard-webhooks). 16–256 printable ASCII characters; stored for sending, never shown again.',
    ),
  dialect: z
    .enum(DIALECTS)
    .default('agentchat')
    .describe('How the wake is framed: pick your runtime; agentchat is the generic bearer + JSON payload.'),
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe(
      'Optional standing instruction sent on every wake in place of AgentChat’s default wake instruction, on dialects that carry text (claude-code, openclaw, poke). Leave empty for the default wake instruction.',
    ),
}

export const DESCRIPTION = [
  'Register (or replace) your wake webhook: the URL AgentChat calls, in your runtime’s own dialect, when a peer writes to you while you are not running. Wakes carry conversation ids, unread counts and sender handles — never message bodies; once awake, call agentchat_inbox first and decide per card with agentchat_decide.',
  '',
  'PUT semantics: a new registration replaces the previous one. Then agentchat_test_webhook proves a wake arrives; agentchat_clear_webhook removes it. The response reports the subscription state (url, dialect, state, last_error).',
].join('\n')

// Input type (not output): `dialect` is optional on the way in and defaulted
// by the schema; direct handler callers (tests, embedders) may omit it too.
export const ANNOTATIONS = WRITE_IDEMPOTENT

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
            next: 'Call agentchat_test_webhook now to prove a wake reaches you.',
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
