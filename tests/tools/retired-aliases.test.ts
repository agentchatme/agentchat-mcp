import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMcpServer, type ToolVisibility } from '../../src/lib.js'
import { registerAllTools, RETIRED_TOOL_NAMES, TOOL_NAMES } from '../../src/tools/index.js'
import { hideFromListing, storedListHandler, UNHIDDEN_ALIASES_WARNING } from '../../src/tools/_retired.js'
import { fetchStub, json, KEY, makeRealCtx, pathOf } from './_real-client.js'

// ─── Retired names: callable, never listed ─────────────────────────────────
//
// Until their old paths are switched off (contract v1 §7) the three old
// names still work (texts in the field name them) but never show in
// tools/list under any visibility, and every answer ends with the line that
// names the successor and says how long it keeps working. Driven through
// the public library entry and a real MCP transport, with the network
// stubbed.

async function connect(visibility?: ToolVisibility, apiKey: string | null = KEY) {
  const server = buildMcpServer({
    apiBase: 'https://api.agentchat.test',
    apiKey,
    ...(apiKey ? { selfHandle: 'me' } : {}),
    ...(visibility ? { visibility } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'retired', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function texts(result: { content: unknown[] }): string[] {
  return (result.content as Array<{ type: string; text: string }>).map((block) => block.text)
}

const SITUATIONS: Array<ToolVisibility | undefined> = [
  undefined,
  { registered: false, webhookTools: false },
  { registered: true, webhookTools: false },
  { registered: true, webhookTools: true },
]

describe('retired tool names', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('are exactly the three Phase 4 names, and none of them is in the listed surface', () => {
    expect(RETIRED_TOOL_NAMES).toEqual([
      'agentchat_list_inbox',
      'agentchat_accept_group_invite',
      'agentchat_reject_group_invite',
    ])
    for (const name of RETIRED_TOOL_NAMES) expect(TOOL_NAMES).not.toContain(name)
  })

  it('never appear in tools/list, under any visibility', async () => {
    for (const visibility of SITUATIONS) {
      const { client, close } = await connect(visibility, visibility?.registered === false ? null : KEY)
      try {
        const { tools } = await client.listTools()
        const names = tools.map((tool) => tool.name)
        for (const retired of RETIRED_TOOL_NAMES) {
          expect(names, JSON.stringify(visibility)).not.toContain(retired)
        }
        // The filter removes only the aliases: the listing is otherwise intact.
        expect(names.length).toBeGreaterThan(0)
        expect(new Set(names).size).toBe(names.length)
      } finally {
        await close()
      }
    }
  })

  it('agentchat_list_inbox runs agentchat_list_conversations and names the successor', async () => {
    const { impl, calls } = fetchStub(() =>
      json(200, [
        { id: 'conv_1', type: 'direct', participants: [{ handle: 'bob', display_name: null }], unread_count: 1 },
      ]),
    )
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect({ registered: true, webhookTools: false })
    try {
      const result = await client.callTool({ name: 'agentchat_list_inbox', arguments: { limit: 3, offset: 0 } })
      expect(result.isError).toBeFalsy()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.method).toBe('GET')
      expect(new URL(calls[0]!.url).pathname).toBe('/v1/conversations')
      const [payload, line] = texts(result as { content: unknown[] })
      expect(JSON.parse(payload!)).toMatchObject({
        count: 1,
        conversations: [{ conversation_id: 'conv_1', counterparty: { handle: '@bob' } }],
      })
      expect(line).toBe(
        'agentchat_list_inbox is a retired name: call agentchat_list_conversations instead. It keeps working until its old path is switched off (https://agentchat.me/contract/v1/#deprecations), then it is removed.',
      )
    } finally {
      await close()
    }
  })

  it('agentchat_accept_group_invite / agentchat_reject_group_invite run agentchat_respond_to_invite with the matching response', async () => {
    const { impl, calls } = fetchStub((call) =>
      call.method === 'POST'
        ? json(200, { id: 'grp_1', name: 'ops', member_count: 3, your_role: 'member' })
        : json(200, { message: 'Invite rejected' }),
    )
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect()
    try {
      const accepted = await client.callTool({
        name: 'agentchat_accept_group_invite',
        arguments: { invite_id: 'inv_1' },
      })
      expect(accepted.isError).toBeFalsy()
      expect([calls[0]!.method, pathOf(calls[0]!)]).toEqual(['POST', '/v1/groups/invites/inv_1/accept'])
      const [acceptPayload, acceptLine] = texts(accepted as { content: unknown[] })
      expect(JSON.parse(acceptPayload!)).toMatchObject({ response: 'accept', outcome: 'joined' })
      expect(acceptLine).toContain('call agentchat_respond_to_invite with response "accept" instead')

      const declined = await client.callTool({
        name: 'agentchat_reject_group_invite',
        arguments: { invite_id: 'inv_2' },
      })
      expect(declined.isError).toBeFalsy()
      expect([calls[1]!.method, pathOf(calls[1]!)]).toEqual(['DELETE', '/v1/groups/invites/inv_2'])
      const [declinePayload, declineLine] = texts(declined as { content: unknown[] })
      expect(JSON.parse(declinePayload!)).toMatchObject({ response: 'decline', outcome: 'declined' })
      expect(declineLine).toContain('call agentchat_respond_to_invite with response "decline" instead')
    } finally {
      await close()
    }
  })

  it('follow their successor’s gate: not registered for an unregistered session', async () => {
    const { client, close } = await connect({ registered: false, webhookTools: false }, null)
    try {
      const result = await client.callTool({ name: 'agentchat_list_inbox', arguments: {} })
      expect(result.isError).toBe(true)
      expect(texts(result as { content: unknown[] })[0]).toMatch(/not found/i)
    } finally {
      await close()
    }
  })

  it('an error answer still ends with the successor line', async () => {
    const { impl } = fetchStub(() => json(404, { code: 'INVITE_NOT_FOUND', message: 'Invite not found' }))
    vi.stubGlobal('fetch', impl)
    const { client, close } = await connect()
    try {
      const result = await client.callTool({
        name: 'agentchat_reject_group_invite',
        arguments: { invite_id: 'inv_gone' },
      })
      expect(result.isError).toBe(true)
      const [error, line] = texts(result as { content: unknown[] })
      expect(error).toContain('Error: INVITE_NOT_FOUND')
      expect(line).toContain('agentchat_respond_to_invite')
    } finally {
      await close()
    }
  })
})

// ─── The one private touch, and what happens without it ────────────────────
//
// hideFromListing reads the MCP SDK's stored tools/list handler from the
// protocol layer's `_requestHandlers` map. The suite below fails the build
// if the pinned SDK keeps it anywhere else (or if the pin stops being
// exact), and proves that an install on such an SDK still starts: the
// aliases are listed too, still work, and one warning is logged per logger.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

function bareServer(): McpServer {
  return new McpServer({ name: 'agentchat', version: '0.0.0' }, { capabilities: { tools: {} } })
}

/** A logger whose lines this test can read. */
function capturingLogger(): { logger: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const written: string[] = []
  const logger = pino({ level: 'warn' }, { write: (line: string) => void written.push(line) })
  return { logger, lines: () => written.map((line) => JSON.parse(line) as Record<string, unknown>) }
}

/**
 * Stand in for an MCP SDK that stores its handlers in something other than a
 * Map: the protocol layer keeps working (it only calls get / set / has /
 * delete), but the shape hideFromListing reads is gone.
 */
function moveHandlersOutOfAMap(server: McpServer): void {
  const inner = server.server as unknown as { _requestHandlers: Map<string, unknown> }
  const real = inner._requestHandlers
  const registry = {
    get: (key: string) => real.get(key),
    set: (key: string, value: unknown) => {
      real.set(key, value)
      return registry
    },
    has: (key: string) => real.has(key),
    delete: (key: string) => real.delete(key),
  }
  ;(inner as unknown as { _requestHandlers: unknown })._requestHandlers = registry
}

async function connectServer(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'retired-hook', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('the listing filter and the MCP SDK it reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the installed MCP SDK keeps its tools/list handler where hideFromListing reads it', () => {
    const server = bareServer()
    server.registerTool('agentchat_probe', { description: 'probe' }, async () => ({ content: [] }))
    // If this fails, the pinned SDK moved the handler: update storedListHandler
    // in src/tools/_retired.ts for it before shipping that SDK.
    expect(typeof storedListHandler(server)).toBe('function')
    const { logger, lines } = capturingLogger()
    expect(hideFromListing(server, ['agentchat_probe'], logger)).toBe(true)
    expect(lines()).toEqual([])
  })

  it('@modelcontextprotocol/sdk is pinned to one exact version, and that version is installed', () => {
    const spec = (readJson(path.join(ROOT, 'package.json'))['dependencies'] as Record<string, string>)[
      '@modelcontextprotocol/sdk'
    ]
    expect(spec, 'an exact version, never a range').toMatch(/^\d+\.\d+\.\d+$/)
    const installed = readJson(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))
    expect(installed['version']).toBe(spec)
  })

  it('a stored handler that answers another shape is passed through, never broken', async () => {
    const odd = { nextCursor: 'c1' } // no `tools` array
    let installed: ((request: unknown, extra: unknown) => Promise<unknown>) | null = null
    const fake = {
      server: {
        _requestHandlers: new Map([['tools/list', async () => odd]]),
        setRequestHandler: (_schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) => {
          installed = handler
        },
      },
    } as unknown as McpServer
    const { logger } = capturingLogger()
    expect(hideFromListing(fake, ['agentchat_list_inbox'], logger)).toBe(true)
    expect(await installed!({ method: 'tools/list' }, {})).toBe(odd)
  })

  it('reading the hook never throws, whatever the SDK keeps there', () => {
    const shapes: unknown[] = [undefined, null, {}, new Map(), new Map([['tools/list', 'not a function']])]
    for (const shape of shapes) {
      const server = { server: { _requestHandlers: shape } } as unknown as McpServer
      expect(storedListHandler(server)).toBeNull()
    }
    const throwing = {
      server: Object.defineProperty({}, '_requestHandlers', {
        get() {
          throw new Error('private field moved')
        },
      }),
    } as unknown as McpServer
    expect(storedListHandler(throwing)).toBeNull()
  })

  it('without the hook the server still starts: aliases listed and callable, one warning per logger', async () => {
    const { impl } = fetchStub(() =>
      json(200, [{ id: 'conv_1', type: 'direct', participants: [{ handle: 'bob', display_name: null }], unread_count: 1 }]),
    )
    const { logger, lines } = capturingLogger()
    const ctx = makeRealCtx(impl)
    ctx.logger = logger
    const visibility = { registered: true, webhookTools: false }

    const server = bareServer()
    moveHandlersOutOfAMap(server)
    const listed = registerAllTools(server, ctx, visibility)
    // A second server on the same logger (a hosted endpoint builds one per
    // request) adds no second line.
    const again = bareServer()
    moveHandlersOutOfAMap(again)
    registerAllTools(again, ctx, visibility)

    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({ level: 40, msg: UNHIDDEN_ALIASES_WARNING, aliases: [...RETIRED_TOOL_NAMES] })

    const { client, close } = await connectServer(server)
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names).toEqual([...listed, ...RETIRED_TOOL_NAMES])
      const result = await client.callTool({ name: 'agentchat_list_inbox', arguments: {} })
      expect(result.isError).toBeFalsy()
      expect(texts(result as { content: unknown[] }).at(-1)).toContain('call agentchat_list_conversations instead')
    } finally {
      await close()
      await again.close()
    }
  })
})
