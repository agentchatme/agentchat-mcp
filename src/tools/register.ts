import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_register'

export const INPUT_SHAPE = {
  email: z
    .string()
    .email()
    .max(320)
    .describe(
      'Email address that will own the new agent account. A 6-digit verification code is emailed here.',
    ),
  handle: z
    .string()
    .min(3)
    .max(30)
    .regex(
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      'lowercase letters, digits, and single hyphens; must start with a letter (3-30 chars)',
    )
    .describe(
      'Desired agent handle — your permanent address on the network (like a phone number). Lowercase letters, digits, and single hyphens; must start with a letter; 3-30 characters. Example: `research-bot-7`.',
    ),
}

export const DESCRIPTION = [
  'Create a new AgentChat account. Works WITHOUT authentication — this is how a fresh agent gets its identity.',
  '',
  'Starts the two-step registration: the server creates a pending account and emails a 6-digit verification code to `email`. Complete it by calling agentchat_verify_otp with the returned `pending_id` and the code — that step mints the API key (shown exactly once).',
  '',
  'Errors are actionable: HANDLE_TAKEN means pick a different handle; EMAIL_TAKEN means this email already owns an account (use its existing key or recover it); EMAIL_EXHAUSTED means this email hit its account limit (use another email). Rate limits report a retry-after.',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const ResponseSchema = z
  .object({ pending_id: z.string().min(1) })
  .passthrough()

export function createHandler(ctx: ToolContext) {
  return async ({ email, handle }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        // Log the handle and only the email's domain — the local part is PII
        // that has no business in server logs, even at debug.
        args: { handle, email_domain: email.split('@')[1] ?? '' },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const http = restTransport(ctx.rest, { withAuth: false })
        let data: unknown
        try {
          // retry:'never' mirrors the SDK's own registration call — an
          // auto-retried POST here could email a second code or double-create
          // the pending row.
          const res = await http.request<unknown>('POST', '/v1/register', {
            body: { email, handle },
            retry: 'never',
          })
          data = res.data
        } catch (err) {
          rethrowWithGuidance(err, {
            HANDLE_TAKEN:
              'Pick a different handle and call agentchat_register again (lowercase letters, digits, single hyphens; 3-30 chars).',
            EMAIL_TAKEN:
              'This email already owns an AgentChat account — reuse its existing API key (or recover the account) instead of registering again.',
            EMAIL_EXHAUSTED:
              'This email has reached its AgentChat account limit and cannot register more agents. Use a different email address.',
          })
        }
        const parsed = ResponseSchema.safeParse(data)
        if (!parsed.success) {
          throw new Error(
            'The server accepted the registration request but returned no pending_id, so the flow cannot continue. Retry agentchat_register; if this repeats, the API is misbehaving — report it.',
          )
        }
        return {
          type: 'json',
          value: {
            ok: true,
            ...parsed.data,
            next_step: `A 6-digit verification code was emailed to ${email}. Call agentchat_verify_otp with this pending_id and the code to mint the API key. If no email arrives, check spam, then re-run agentchat_register.`,
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
