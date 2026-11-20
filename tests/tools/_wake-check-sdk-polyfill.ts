import { AgentChatClient, AgentChatError } from 'agentchatme'

// ─── TEMPORARY: a test stand-in for the SDK's `client.wakeCheck` ───────────
//
// The wake-check tools call `client.wakeCheck.set` / `.clear`, which
// agentchatme adds in its next release (src/tools/_wake-check-sdk.ts). The
// repo's tool tests stub fetch under a REAL client, so the whole chain a host
// depends on is proven: the URL, method and body on the wire, and the SDK's
// real error pipeline (status → typed error → tool guidance → mapped tool
// error). Until the SDK has the resource, this module gives the installed
// client a stand-in with the SDK's wire behaviour, over the client's own
// transport, so that pipeline stays real:
//   * set: PUT /v1/agents/me/wake-check with only the documented fields
//     (`{}` when neither is given), unwrapping `{ wake_check }`; the
//     client's retry policy, except that a 503 WAKE_CHECK_UNAVAILABLE is
//     never retried (it says the server cannot run wake checks at all);
//   * clear: DELETE /v1/agents/me/wake-check, the answer as it came.
//
// It installs nothing when the SDK has the resource: the same tests then run
// against the SDK's own implementation, and every wire assertion in them
// becomes a check that the SDK matches the contract. Importing it is the
// opt-in; only tests that call the wake-check tools import it. Delete it
// together with src/tools/_wake-check-sdk.ts when the dependency is bumped
// (tests/tools/wake-check-sdk-shim.test.ts fails on that bump).

/** Marks the stand-in resource, so a test can tell it from the SDK's own. */
export const POLYFILL = Symbol.for('@agentchatme/mcp.test.wakeCheckPolyfill')

const PATH = '/v1/agents/me/wake-check'
const TERMINAL_CODE = 'WAKE_CHECK_UNAVAILABLE'

/** The client internals the stand-in uses (TypeScript-private in the SDK, ordinary members at runtime). */
interface Internals {
  http: { fetchFn: typeof fetch }
  put<T>(path: string, body?: unknown): Promise<T>
  del<T>(path: string): Promise<T>
}

/**
 * The SDK's transport retries every 503 on a PUT; the release with the wake
 * check makes WAKE_CHECK_UNAVAILABLE terminal. The stand-in gets the same
 * effect at the fetch boundary, for this one call: such an answer reaches
 * the installed transport as a 501 (a ServerError it does not retry, built
 * from the same body), and the error's status is put back to 503. The client
 * is the tool's own (one per call), so nothing else sees the swap.
 */
async function withTerminalUnavailable<T>(client: Internals, call: () => Promise<T>): Promise<T> {
  const http = client.http
  const original = http.fetchFn
  let terminal = false
  http.fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await original(input, init)
    if (res.status !== 503) return res
    const text = await res.text()
    let code: unknown
    try {
      code = (JSON.parse(text) as { code?: unknown } | null)?.code
    } catch {
      code = undefined
    }
    terminal = code === TERMINAL_CODE
    return new Response(text, {
      status: terminal ? 501 : 503,
      statusText: res.statusText,
      headers: res.headers,
    })
  }) as typeof fetch
  try {
    return await call()
  } catch (err) {
    if (terminal && err instanceof AgentChatError) (err as { status: number }).status = 503
    throw err
  } finally {
    http.fetchFn = original
  }
}

function standIn(client: Internals): object {
  return {
    [POLYFILL]: true,
    set: async (opts?: { rewake?: boolean; rotate?: boolean }): Promise<unknown> => {
      const body = {
        ...(opts?.rewake !== undefined ? { rewake: opts.rewake } : {}),
        ...(opts?.rotate !== undefined ? { rotate: opts.rotate } : {}),
      }
      const res = await withTerminalUnavailable(client, () => client.put<{ wake_check: unknown }>(PATH, body))
      return res.wake_check
    },
    clear: (): Promise<unknown> => client.del<unknown>(PATH),
  }
}

// The SDK sets its resources in the constructor, so a client built here (no
// I/O) shows whether the installed SDK has one.
const probe = new AgentChatClient({ apiKey: 'probe', baseUrl: 'https://probe.invalid' })

if ((probe as unknown as { wakeCheck?: unknown }).wakeCheck === undefined) {
  Object.defineProperty(AgentChatClient.prototype, 'wakeCheck', {
    configurable: true,
    get(this: Internals) {
      return standIn(this)
    },
    // A constructor that assigns its own resource keeps working.
    set(this: object, value: unknown) {
      Object.defineProperty(this, 'wakeCheck', { value, writable: true, enumerable: true, configurable: true })
    },
  })
}
