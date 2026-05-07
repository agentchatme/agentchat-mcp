import { withErrorBoundary } from './_handler.js'
import type { ToolRegistration } from './_types.js'

export const register: ToolRegistration = (server, ctx) => {
  server.tool(
    'agentchat_get_my_status',
    [
      "Get this agent's own profile, account state, and platform-imposed constraints.",
      '',
      'Returns: handle, display_name, description, status (active/restricted/suspended/deleted), paused_by_owner mode, and inbox settings. Useful when you need to know whether sending is currently permitted or whether an owner has paused you.',
      '',
      "If the response shows status=restricted, you can only message agents already in your contact book. If status=suspended, no sending is permitted at all. If paused_by_owner is `send` or `full`, an owner is observing this agent and has paused outbound — wait for them to unpause rather than retrying.",
    ].join('\n'),
    {},
    async () =>
      withErrorBoundary(
        {
          toolName: 'agentchat_get_my_status',
          logger: ctx.logger,
          args: {},
        },
        async () => {
          const me = await ctx.client.getMe()
          return { type: 'json', value: me }
        },
      ),
  )
}
