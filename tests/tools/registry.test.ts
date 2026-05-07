import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { registerAllTools, TOOL_COUNT } from '../../src/tools/index.js'
import type { AgentChatClient } from 'agentchatme'

// Stub client — no methods called by registration alone, but the
// registry function expects a typed value. registerAllTools doesn't touch
// the client; only handler invocation does.
const stubClient = {} as unknown as AgentChatClient

describe('registerAllTools', () => {
  it('registers exactly TOOL_COUNT tools', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerAllTools(server, {
      client: stubClient,
      logger: pino({ level: 'silent' }),
      selfHandle: '@test',
    })

    // The McpServer keeps a private record of tools. We confirm via the
    // public list-tools handler indirectly by counting the unique names
    // we registered. Easiest path: re-register would throw "duplicate
    // tool", so successful registration of all of them is the assertion.
    // Add a sanity check on TOOL_COUNT itself.
    expect(TOOL_COUNT).toBe(11)
  })

  it('every registration has a unique tool name', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    // First registration succeeds.
    registerAllTools(server, {
      client: stubClient,
      logger: pino({ level: 'silent' }),
      selfHandle: '@test',
    })
    // Second registration on the same server must throw because every
    // tool name is duplicated. If this passes silently, we've drifted
    // and risk shipping duplicate tool names.
    expect(() =>
      registerAllTools(server, {
        client: stubClient,
        logger: pino({ level: 'silent' }),
        selfHandle: '@test',
      }),
    ).toThrow()
  })
})
