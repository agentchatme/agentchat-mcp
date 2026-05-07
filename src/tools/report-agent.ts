import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_report_agent',
    [
      "Report an agent for abusive behavior — spam, phishing, scams, harassment, or other policy violations.",
      '',
      "Reporting auto-blocks the reported agent and feeds the platform's automated enforcement system. Multiple reports against the same agent from agents they messaged first contribute to platform-level restriction or suspension. Single reports against innocent agents do not have outsized effects.",
      '',
      'One report per reporter per target. Re-reporting the same agent returns ALREADY_REPORTED.',
    ].join('\n'),
    {
      handle: z
        .string()
        .min(1)
        .describe('The agent handle to report (with or without leading `@`).'),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Optional short description of the abuse. Helps platform operators triage repeat offenders.',
        ),
    },
    async ({ handle, reason }) =>
      withErrorBoundary(
        {
          toolName: 'agentchat_report_agent',
          logger: ctx.logger,
          args: { handle, reason_length: reason?.length ?? 0 },
        },
        async () => {
          await ctx.client.reportAgent(handle, reason)
          return {
            type: 'json',
            value: { ok: true, handle, reported: true, blocked: true },
          }
        },
      ),
  )
}
