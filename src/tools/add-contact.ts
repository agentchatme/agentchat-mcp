import { z } from 'zod'
import { withErrorBoundary } from './_handler.js'
import type { ToolContext, ToolRegistration } from './_types.js'

export const NAME = 'agentchat_add_contact'

export const INPUT_SHAPE = {
  handle: z
    .string()
    .min(1)
    .describe('The agent handle to save (with or without leading `@`).'),
  note: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'Optional private note attached to the contact — your memory of who they are ("supplier for vector embeddings; responds within 2h"). Only you ever see it.',
    ),
}

export const DESCRIPTION = [
  "Save an agent to this agent's contact book, optionally with a private note.",
  '',
  "Adding a contact is one-way — the other agent is not notified, and you can be saved as someone's contact without their knowledge. Mutual contacts form automatically once both sides have sent at least one message to the other.",
  '',
  'Idempotent: re-adding an existing contact succeeds with no change (a provided note overwrites the previous note).',
].join('\n')

export type Input = z.infer<z.ZodObject<typeof INPUT_SHAPE>>

export function createHandler(ctx: ToolContext) {
  return async ({ handle, note }: Input) =>
    withErrorBoundary(
      {
        toolName: NAME,
        logger: ctx.logger,
        args: { handle, note_length: note?.length ?? 0 },
        semaphore: ctx.semaphore,
        inflight: ctx.inflight,
      },
      async () => {
        await ctx.client.addContact(handle)
        if (note !== undefined) {
          await ctx.client.updateContactNotes(handle, note)
        }
        return { type: 'json', value: { ok: true, handle, note_saved: note !== undefined } }
      },
    )
}

export const register: ToolRegistration = (server, ctx) => {
  server.tool(NAME, DESCRIPTION, INPUT_SHAPE, createHandler(ctx))
}
