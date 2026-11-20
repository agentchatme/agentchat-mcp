import type { AgentChatClient } from 'agentchatme'

// ─── TEMPORARY: the SDK's wake-check methods, until agentchatme ships them ──
//
// agentchatme's next release adds two client methods, the wire for the wake
// check (PUT / DELETE /v1/agents/me/wake-check):
//
//   setWakeCheck(opts?: { rewake?: boolean; rotate?: boolean }): Promise<WakeCheckStatus>
//   clearWakeCheck(): Promise<{ cleared: boolean }>
//
// This package still depends on a release without them, so their types are
// declared here, as the SDK declares them, and `wakeCheckMethods` is the one
// place the two wake-check tools reach them. Nothing else in src/ may
// import this file.
//
// When the dependency is bumped to the release that has them: delete this
// file, import `WakeCheckStatus` from 'agentchatme', call
// `client.setWakeCheck` / `client.clearWakeCheck` directly, and delete
// tests/tools/_wake-check-sdk-polyfill.ts. tests/tools/wake-check-sdk-shim.test.ts
// fails on that bump, so this file cannot outlive its reason.

/** The wake check as the server reports it (`{ wake_check: … }` on PUT and on GET /v1/agents/me). */
export interface WakeCheckStatus {
  /** The check address: the URL a hook or poller calls with no key. */
  url: string
  rewake: boolean
  created_at: string
  last_seen_at: string | null
}

/** Options for `setWakeCheck` (the PUT body; an absent key takes the server's default). */
export interface SetWakeCheckOptions {
  rewake?: boolean
  rotate?: boolean
}

/** What `clearWakeCheck` returns (the DELETE answer). */
export interface ClearWakeCheckResult {
  cleared: boolean
}

export interface WakeCheckMethods {
  setWakeCheck(opts?: SetWakeCheckOptions): Promise<WakeCheckStatus>
  clearWakeCheck(): Promise<ClearWakeCheckResult>
}

/**
 * The client, typed with the two methods. Throws when the installed SDK does
 * not have them, so a build released on an older SDK says why instead of
 * failing with "is not a function".
 */
export function wakeCheckMethods(client: AgentChatClient): WakeCheckMethods {
  const view = client as unknown as Partial<WakeCheckMethods>
  if (typeof view.setWakeCheck !== 'function' || typeof view.clearWakeCheck !== 'function') {
    throw new Error(
      'This build of @agentchatme/mcp runs on an agentchatme SDK without the wake-check methods, so it cannot set or clear a wake check. Upgrade @agentchatme/mcp.',
    )
  }
  return view as WakeCheckMethods
}
