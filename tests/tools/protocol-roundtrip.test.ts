import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type AgentChatClient } from 'agentchatme'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import { registerAllTools } from '../../src/tools/index.js'
import type { ToolContext } from '../../src/tools/_types.js'

// ─── Protocol round-trips ──────────────────────────────────────────────────
//
// The handler tests call createHandler() directly, which bypasses two things
// only the real MCP server does: parsing arguments through the zod shape
// (defaults, blank handling) and aborting `extra.signal` on
// notifications/cancelled. These tests drive the server through the SDK's
// in-memory transport so both are exercised exactly as a host exercises them,
// and sweep tools/list for the wire schema every host receives.

type FetchCall = { url: string; method: string; signal: AbortSignal | undefined }

function fetchStub(respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      signal: init?.signal ?? undefined,
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { impl, calls }
}

function hang(call: FetchCall): Promise<Response> {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error('This operation was aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (call.signal?.aborted) fail()
    else call.signal?.addEventListener('abort', fail, { once: true })
  })
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const KEY = 'ac_live_0123456789abcdef0123456789abcdef'

function makeCtx(fetchImpl: typeof fetch): ToolContext {
  return {
    client: {} as AgentChatClient,
    logger: pino({ level: 'silent' }),
    selfHandle: '@me',
    semaphore: new Semaphore(10),
    inflight: new Set(),
    rest: { apiBase: 'https://api.agentchat.test', apiKey: KEY, fetchImpl },
    turnKey: () => undefined,
  }
}

async function connect(ctx: ToolContext) {
  const server = new McpServer({ name: 'roundtrip', version: '0.0.0' })
  registerAllTools(server, ctx)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'roundtrip', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('agentchat_wait over the MCP protocol', () => {
  it('blank optionals (null / "") parse to the defaults before the handler runs', async () => {
    const { impl, calls } = fetchStub(() => json(200, []))
    const { client, close } = await connect(makeCtx(impl))
    try {
      const result = await client.callTool({
        name: 'agentchat_wait',
        arguments: { timeout_seconds: null, limit: '' },
      })
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      const sync = new URL(calls[0]!.url)
      expect(sync.searchParams.get('wait_ms')).toBe('45000')
      expect(sync.searchParams.get('limit')).toBe('50')
    } finally {
      await close()
    }
  })

  it('notifications/cancelled aborts the park, frees the slot, and nothing is acked', async () => {
    const { impl, calls } = fetchStub((call) => hang(call))
    const ctx = makeCtx(impl)
    const { client, close } = await connect(ctx)
    try {
      const ac = new AbortController()
      const pending = client.callTool(
        { name: 'agentchat_wait', arguments: { timeout_seconds: 45, limit: 50 } },
        undefined,
        { signal: ac.signal },
      )
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      expect(ctx.inflight.size).toBe(1)
      expect(ctx.semaphore.inFlight).toBe(1)

      // The client gives up: the SDK sends notifications/cancelled to the
      // server, which aborts the handler's extra.signal.
      ac.abort(new Error('host gave up'))
      await expect(pending).rejects.toThrow()

      await vi.waitFor(() => expect(ctx.inflight.size).toBe(0))
      expect(ctx.semaphore.inFlight).toBe(0)
      expect(calls[0]!.signal?.aborted).toBe(true)
      expect(calls.filter((call) => call.url.endsWith('/v1/messages/sync/ack'))).toHaveLength(0)
    } finally {
      await close()
    }
  })
})

describe('tools/list wire schema', () => {
  // Every `format` an MCP host receives must be a JSON Schema format, not a
  // zod-internal check name. Strict hosts validate the schema itself.
  const STANDARD_FORMATS = new Set([
    'date-time',
    'date',
    'time',
    'duration',
    'email',
    'hostname',
    'ipv4',
    'ipv6',
    'uri',
    'uri-reference',
    'uuid',
    'regex',
  ])

  function collectFormats(node: unknown, path: string, into: Map<string, string>) {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'format' && typeof value === 'string') into.set(path, value)
      else collectFormats(value, `${path}.${key}`, into)
    }
  }

  it('uses only standard JSON Schema formats, and set_webhook.url carries the https rule as format + pattern', async () => {
    const { impl } = fetchStub(() => json(200, []))
    const { client, close } = await connect(makeCtx(impl))
    try {
      const { tools } = await client.listTools()
      const formats = new Map<string, string>()
      for (const tool of tools) collectFormats(tool.inputSchema, tool.name, formats)
      for (const [where, format] of formats) {
        expect(STANDARD_FORMATS.has(format), `${where} has non-standard format "${format}"`).toBe(true)
      }

      const setWebhook = tools.find((tool) => tool.name === 'agentchat_set_webhook')
      expect(setWebhook).toBeDefined()
      const properties = (setWebhook!.inputSchema as { properties: Record<string, Record<string, unknown>> })
        .properties
      expect(properties['url']).toMatchObject({
        type: 'string',
        format: 'uri',
        pattern: '^https:\\/\\/',
        maxLength: 2048,
      })
      expect(typeof properties['url']!['description']).toBe('string')
    } finally {
      await close()
    }
  })
})
