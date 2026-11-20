import { AgentChatClient } from 'agentchatme'

// ─── TEMPORARY: a test stand-in for the SDK's wake-check methods ───────────
//
// The wake-check tools call `client.setWakeCheck` / `client.clearWakeCheck`,
// which agentchatme adds in its next release (src/tools/_wake-check-sdk.ts).
// The repo's tool tests stub fetch under a REAL client, so the whole chain a
// host depends on is proven: the URL, method and body on the wire, and the
// SDK's real error pipeline (status → typed error → tool guidance → mapped
// tool error). Until the SDK has the two methods, this module gives the
// installed client a stand-in built the way the SDK builds its wake-webhook
// call (`setWakeWebhook`: the documented fields only, PUT, unwrap the
// envelope), over the client's own transport, so that pipeline stays real.
//
// It installs nothing when the SDK has the methods: the same tests then run
// against the SDK's own implementation, and every wire assertion in them
// becomes a check that the SDK matches the contract. Importing it is the
// opt-in; only tests that call the wake-check tools import it. Delete it
// together with src/tools/_wake-check-sdk.ts when the dependency is bumped
// (tests/tools/wake-check-sdk-shim.test.ts fails on that bump).

/** Marks the stand-ins, so a test can tell them from the SDK's own methods. */
export const POLYFILL = Symbol.for('@agentchatme/mcp.test.wakeCheckPolyfill')

/** The client's own transport calls (TypeScript-private in the SDK, ordinary methods at runtime). */
interface Transport {
  put<T>(path: string, body?: unknown): Promise<T>
  del<T>(path: string): Promise<T>
}

const PATH = '/v1/agents/me/wake-check'
const proto = AgentChatClient.prototype as unknown as Record<string | symbol, unknown>

if (typeof proto['setWakeCheck'] !== 'function') {
  const setWakeCheck = async function (
    this: Transport,
    opts?: { rewake?: boolean; rotate?: boolean },
  ): Promise<unknown> {
    const body = {
      ...(opts?.rewake !== undefined ? { rewake: opts.rewake } : {}),
      ...(opts?.rotate !== undefined ? { rotate: opts.rotate } : {}),
    }
    const res = await this.put<{ wake_check: unknown }>(PATH, body)
    return res.wake_check
  }
  proto['setWakeCheck'] = Object.assign(setWakeCheck, { [POLYFILL]: true })
}

if (typeof proto['clearWakeCheck'] !== 'function') {
  const clearWakeCheck = function (this: Transport): Promise<unknown> {
    return this.del<unknown>(PATH)
  }
  proto['clearWakeCheck'] = Object.assign(clearWakeCheck, { [POLYFILL]: true })
}
