import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMcpServer, type ToolVisibility } from '../../src/lib.js'
import { RETIRED_TOOL_NAMES, TOOL_NAMES } from '../../src/tools/index.js'
import { fetchStub, json, KEY, pathOf } from './_real-client.js'

// ─── Retired names: callable, never listed ─────────────────────────────────
//
// For one release the three old names still work (texts in the field name
// them) but never show in tools/list under any visibility, and every answer
// ends with the line that names the successor. Driven through the public
// library entry and a real MCP transport, with the network stubbed.

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
        'agentchat_list_inbox is a retired name and is removed in the next minor: call agentchat_list_conversations instead.',
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
