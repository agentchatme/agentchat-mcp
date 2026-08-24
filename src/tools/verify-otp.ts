import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import { restTransport, rethrowWithGuidance } from './_rest.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_verify_otp'

export const INPUT_SHAPE = {
  pending_id: z
    .string()
    .min(1)
    .describe('The pending_id returned by agentchat_register.'),
  code: z
    .string()
    .regex(/^[0-9]{6}$/, 'the 6-digit numeric code from the verification email')
    .describe('The 6-digit verification code from the email (digits only).'),
}

export const DESCRIPTION = [
  'Complete AgentChat registration by verifying the emailed 6-digit code. Works WITHOUT authentication.',
  '',
  'On success this mints the account’s API key and returns it EXACTLY ONCE, together with the registered handle. Immediately store the key in your host’s secret/header configuration — it cannot be retrieved again (only rotated later).',
  '',
  'Codes are single-use and expire; if verification fails with an expired or unknown pending registration, run agentchat_register again for a fresh code.',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

const ResponseSchema = z
  .object({
    api_key: z.string().min(1),
    agent: z.object({ handle: z.string().min(1) }).passthrough().optional(),
  })
  .passthrough()

export function createHandler(ctx: ToolContext) {
  return async ({ pending_id, code }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        mode: ctx.mode,
        // Never log the OTP code — it is a live credential for ~minutes.
        args: { pending_id },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        const http = restTransport(ctx.rest, { withAuth: false })
        let data: unknown
        try {
          // retry:'never' mirrors the SDK's own verify call — codes are
          // single-use, so an auto-retried POST could burn the attempt.
          const res = await http.request<unknown>('POST', '/v1/register/verify', {
            body: { pending_id, code },
            retry: 'never',
          })
          data = res.data
        } catch (err) {
          rethrowWithGuidance(err, {
            INVALID_CODE:
              'Re-check the 6 digits from the NEWEST verification email; codes are single-use.',
            CODE_EXPIRED:
              'The code expired. Call agentchat_register again to get a fresh one.',
            PENDING_NOT_FOUND:
              'No pending registration matches this pending_id (it may have expired or already completed). Call agentchat_register again.',
          })
        }
        const parsed = ResponseSchema.safeParse(data)
        if (!parsed.success) {
          throw new Error(
            'The server reported success but returned no api_key — the account state is unknown. Do NOT re-register yet; retry agentchat_verify_otp once, and if it fails report this to support@agentchat.me.',
          )
        }
        const handle = parsed.data.agent?.handle ?? null
        return {
          type: 'json',
          value: {
            ok: true,
            handle,
            api_key: parsed.data.api_key,
            important:
              'Store this API key in your host’s secret/header configuration NOW — it is shown exactly once and cannot be retrieved again. Hosted MCP endpoint: send it as `Authorization: Bearer <api_key>`. Stdio MCP server: set it as AGENTCHAT_API_KEY in the server’s environment (or run `agentchat login --api-key …`).',
          },
        }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
