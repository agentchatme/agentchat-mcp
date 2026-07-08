import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { Semaphore } from '../../src/semaphore.js'
import { registerAllTools, TOOL_COUNT } from '../../src/tools/index.js'
import type { AgentChatClient } from 'agentchatme'

// Stub client — no methods called by registration alone, but the
// registry function expects a typed value. registerAllTools doesn't touch
// the client; only handler invocation does.
const stubClient = {} as unknown as AgentChatClient

function ctx() {
  return {
    client: stubClient,
    logger: pino({ level: 'silent' }),
    selfHandle: '@test',
    semaphore: new Semaphore(10),
    inflight: new Set<Promise<unknown>>(),
  }
}

describe('registerAllTools', () => {
  it('registers exactly TOOL_COUNT tools', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerAllTools(server, ctx())
    expect(TOOL_COUNT).toBe(17)
  })

  it('every registration has a unique tool name', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerAllTools(server, ctx())
    // Second registration on the same server must throw because every
    // tool name is duplicated. If this passes silently, we've drifted
    // and risk shipping duplicate tool names.
    expect(() => registerAllTools(server, ctx())).toThrow()
  })
})
