import type { AgentChatClient } from 'agentchatme'

// ─── TEMPORARY: the SDK's wake-check resource, until agentchatme ships it ──
//
// agentchatme's next release adds `client.wakeCheck`, the wire for the wake
// check (PUT / DELETE /v1/agents/me/wake-check), shaped like
// `client.wakeWebhook`:
//
//   wakeCheck.set(options?: SetWakeCheckOptions & CallOptions): Promise<WakeCheckStatus>
//   wakeCheck.clear(options?: CallOptions): Promise<ClearWakeCheckResult>
//
// This package still depends on a release without it, so its types are
// declared here, as the SDK declares them (the call options the two tools
// do not use are left out), and `wakeCheckOf` is the one place the two
// wake-check tools reach it. Nothing else in src/ may import this file.
//
// When the dependency is bumped to the release that has it: delete this
// file, import `WakeCheckStatus` from 'agentchatme', call
// `client.wakeCheck.set` / `client.wakeCheck.clear` directly, and delete
// tests/tools/_wake-check-sdk-polyfill.ts. tests/tools/wake-check-sdk-shim.test.ts
// fails on that bump, so this file cannot outlive its reason.

/** Your wake check as the server reports it (`{ wake_check: … }` on PUT and on GET /v1/agents/me). */
export interface WakeCheckStatus {
  /** The check address: the URL a hook or poller calls with no key. */
  url: string
  rewake: boolean
  created_at: string
  last_seen_at: string | null
}

/** Options for `wakeCheck.set` (the PUT body; an absent key takes the server's default). */
export interface SetWakeCheckOptions {
  rewake?: boolean
  rotate?: boolean
}

/** What `wakeCheck.clear` returns (the DELETE answer). */
export interface ClearWakeCheckResult {
  cleared: boolean
}

/** `client.wakeCheck`. */
export interface WakeCheckResource {
  set(options?: SetWakeCheckOptions): Promise<WakeCheckStatus>
  clear(): Promise<ClearWakeCheckResult>
}

/**
 * The client's `wakeCheck` resource. Throws when the installed SDK does not
 * have it, so a build released on an older SDK says why instead of failing
 * with "cannot read properties of undefined".
 */
export function wakeCheckOf(client: AgentChatClient): WakeCheckResource {
  const resource = (client as unknown as { wakeCheck?: unknown }).wakeCheck
  const usable =
    typeof resource === 'object' &&
    resource !== null &&
    typeof (resource as Partial<WakeCheckResource>).set === 'function' &&
    typeof (resource as Partial<WakeCheckResource>).clear === 'function'
  if (!usable) {
    throw new Error(
      'This build of @agentchatme/mcp runs on an agentchatme SDK without client.wakeCheck, so it cannot set or clear a wake check. Upgrade @agentchatme/mcp.',
    )
  }
  return resource as WakeCheckResource
}
