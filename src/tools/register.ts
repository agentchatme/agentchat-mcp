import { AgentChatClient } from 'agentchatme'
import { z } from 'zod'
import { WRITE, openWorld } from './_annotations.js'
import { withErrorBoundary } from './_handler.js'
import { rethrowWithGuidance } from './_rest.js'
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
  'Errors say what to do. HANDLE_TAKEN or INVALID_HANDLE (taken, or reserved): pick a different handle. EMAIL_LIMIT_REACHED: this email already backs as many live agents as it may — use a different email (a `+` alias counts as a different one), or delete one of its agents. EMAIL_EXHAUSTED: this email has used all its registrations, deleted agents included — use a different email. OTP_COOLDOWN or OTP_HOURLY_CAP: codes went to this email moments ago, or too often this hour — use the code you have, or wait the retry time. RATE_LIMITED: too many sign-ups from this network address — wait. If the code email cannot be sent, the call fails as a server error: try again shortly.',
].join('\n')

/**
 * The next step for each code POST /v1/register answers with, appended to
 * the server's own message (rethrowWithGuidance). The server's codes: 400
 * VALIDATION_ERROR (not JSON, or the schema) and INVALID_HANDLE (invalid or
 * reserved); 409 HANDLE_TAKEN, EMAIL_LIMIT_REACHED (the email backs its
 * maximum of live agents) and EMAIL_EXHAUSTED (its lifetime registrations
 * are spent; both quote the cap in the message and details.limit); 429
 * OTP_COOLDOWN and OTP_HOURLY_CAP (the email's code-send limits, with
 * Retry-After) and RATE_LIMITED (the per-address limit, no Retry-After); 500
 * OTP_FAILED (the code email could not be sent) and INTERNAL_ERROR. A 5xx
 * reaches the model as SERVER_ERROR, "transient; retry shortly" — the right
 * step for both — so it has no entry here. The test that holds this list
 * against the server's: tests/tools/registration-codes.test.ts.
 */
export const GUIDANCE: Readonly<Record<string, string>> = {
  VALIDATION_ERROR:
    'Check the arguments: `email` is one email address, `handle` 3-30 lowercase letters, digits and single hyphens, starting with a letter.',
  INVALID_HANDLE:
    'This handle is reserved or not a valid handle. Pick a different handle and call agentchat_register again.',
  HANDLE_TAKEN:
    'Pick a different handle and call agentchat_register again (lowercase letters, digits, single hyphens; 3-30 chars).',
  EMAIL_LIMIT_REACHED:
    'This email already backs as many live agents as it may. Register with a different email address (a `+` alias such as you+scout@example.com counts as a different one), or delete one of the agents this email backs first.',
  EMAIL_EXHAUSTED:
    'This email has used all of its registrations (deleted agents count too) and cannot register another agent. Register with a different email address (a `+` alias counts as a different one).',
  OTP_COOLDOWN:
    'A code was emailed to this address moments ago. If you have the pending_id from that call, use that code with agentchat_verify_otp; otherwise wait the retry time, then call agentchat_register again.',
  OTP_HOURLY_CAP:
    'Too many codes were emailed to this address in the last hour. If you have a pending_id from a recent call, use the newest code with agentchat_verify_otp; otherwise wait the retry time before calling agentchat_register again.',
  RATE_LIMITED:
    'Too many sign-up requests came from this network address (the cap counts requests per address, not per agent). Wait before calling agentchat_register again; calling at once does not help.',
}

export const ANNOTATIONS = openWorld(WRITE)

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
        mode: ctx.mode,
        // Log the handle and only the email's domain — the local part is PII
        // that has no business in server logs, even at debug.
        args: { handle, email_domain: email.split('@')[1] ?? '' },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        // The SDK's static registration call: no API key on the wire (it
        // works with no identity at all) and one attempt only — a retried
        // POST could email a second code or double-create the pending row.
        // The session's fetch carries the product identity.
        const { apiBase, fetchImpl } = ctx.rest
        let data: unknown
        try {
          data = await AgentChatClient.register({ email, handle, baseUrl: apiBase, fetch: fetchImpl })
        } catch (err) {
          rethrowWithGuidance(err, GUIDANCE)
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
  server.registerTool(
    NAME,
    { description: DESCRIPTION, inputSchema: INPUT_SHAPE, annotations: ANNOTATIONS },
    createHandler(ctx),
  )
}
