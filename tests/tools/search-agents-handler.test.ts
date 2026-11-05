import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as searchAgents from '../../src/tools/search-agents.js'
import { fetchStub, firstText, json, makeRealCtx, pathOf, payloadOf } from './_real-client.js'

// agentchat_search_agents: GET /v1/directory?q= — the phone book.

const PAGE = {
  agents: [
    { handle: 'research-bot-7', display_name: 'Research', description: 'papers', created_at: '2026-01-01T00:00:00Z', in_contacts: true },
    { handle: 'research-two', display_name: null, description: null, created_at: '2026-01-02T00:00:00Z', in_contacts: false },
  ],
  total: 5,
  limit: 2,
  offset: 0,
}

describe('agentchat_search_agents', () => {
  it('GETs the directory with the bare prefix and paging, and shapes public handles', async () => {
    const { impl, calls } = fetchStub(() => json(200, PAGE))
    const result = await searchAgents.createHandler(makeRealCtx(impl))({ query: '@Research', limit: 2, offset: 0 })
    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
    expect(pathOf(calls[0]!)).toBe('/v1/directory?q=research&limit=2')
    expect(payloadOf(result)).toMatchObject({
      query: 'research',
      count: 2,
      total: 5,
      offset: 0,
      has_more: true,
      next_offset: 2,
      agents: [
        { handle: '@research-bot-7', display_name: 'Research', description: 'papers', in_contacts: true },
        { handle: '@research-two', display_name: null, description: null, in_contacts: false },
      ],
    })
  })

  it('reports the last page as has_more:false', async () => {
    const { impl } = fetchStub(() => json(200, { ...PAGE, total: 2 }))
    const result = await searchAgents.createHandler(makeRealCtx(impl))({ query: 'research', limit: 20, offset: 0 })
    expect(payloadOf(result)).toMatchObject({ has_more: false, next_offset: null })
  })

  it('a query shorter than two characters after stripping @ is refused before the network', async () => {
    const { impl, calls } = fetchStub(() => json(200, PAGE))
    const result = await searchAgents.createHandler(makeRealCtx(impl))({ query: '@a', limit: 20, offset: 0 })
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('Error: VALIDATION_ERROR')
    expect(calls).toHaveLength(0)
    const shape = z.object(searchAgents.INPUT_SHAPE)
    expect(shape.safeParse({ query: 'a' }).success).toBe(false)
    expect(shape.safeParse({ query: 'ab' }).success).toBe(true)
    expect(shape.safeParse({ query: 'ab', limit: 51 }).success).toBe(false)
    expect(shape.safeParse({ query: 'ab', offset: 10_001 }).success).toBe(false)
  })

  it('429 carries the directory cap guidance and the retry hint', async () => {
    const { impl } = fetchStub(() =>
      json(429, { code: 'RATE_LIMITED', message: 'Directory-search rate limit reached (60/minute).' }, { 'retry-after': '30' }),
    )
    const result = await searchAgents.createHandler(makeRealCtx(impl))({ query: 'research', limit: 20, offset: 0 })
    expect(result.isError).toBe(true)
    const text = firstText(result)
    expect(text).toContain('Error: RATE_LIMITED')
    expect(text).toContain('60 a minute and 1000 a day')
    expect(text).toContain('Retry after: 30 seconds')
  })
})
