import { ConnectionError, UnauthorizedError, type AgentChatErrorResponse } from 'agentchatme'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We test bootClient's retry behavior by stubbing the SDK constructor's
// `getMe()` via a partial mock module. This isolates the retry policy
// from the real network.

// vi.mock has to be hoisted; the factory captures a closure variable.
const getMeMock = vi.fn()

vi.mock('agentchatme', async () => {
  const actual = await vi.importActual<typeof import('agentchatme')>('agentchatme')
  return {
    ...actual,
    AgentChatClient: vi.fn().mockImplementation(() => ({
      getMe: getMeMock,
    })),
  }
})

import { bootClient } from '../src/client.js'

const silentLogger = pino({ level: 'silent' })
const env = {
  AGENTCHAT_API_KEY: 'ac_test_'.padEnd(40, 'x'),
  AGENTCHAT_API_BASE: 'https://api.agentchat.me',
  AGENTCHAT_MAX_CONCURRENT_TOOLS: 10,
  AGENTCHAT_LOG_LEVEL: 'silent' as const,
}

const errorResponse = (code: string, message: string): AgentChatErrorResponse => ({
  code,
  message,
})

describe('bootClient', () => {
  beforeEach(() => {
    getMeMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns a booted client on first-attempt success', async () => {
    getMeMock.mockResolvedValueOnce({ handle: '@alice', status: 'active' })
    const result = await bootClient(env, silentLogger)
    expect(result.selfHandle).toBe('@alice')
    expect(getMeMock).toHaveBeenCalledTimes(1)
  })

  it('retries on ConnectionError and succeeds on later attempt', async () => {
    getMeMock
      .mockRejectedValueOnce(new ConnectionError('reset'))
      .mockResolvedValueOnce({ handle: '@alice', status: 'active' })
    const result = await bootClient(env, silentLogger, {
      maxAttempts: 3,
      backoffMs: [1, 1],
    })
    expect(result.selfHandle).toBe('@alice')
    expect(getMeMock).toHaveBeenCalledTimes(2)
  })

  it('throws ConnectionError after exhausting retries', async () => {
    getMeMock
      .mockRejectedValueOnce(new ConnectionError('boom'))
      .mockRejectedValueOnce(new ConnectionError('boom'))
      .mockRejectedValueOnce(new ConnectionError('boom'))
    await expect(
      bootClient(env, silentLogger, { maxAttempts: 3, backoffMs: [1, 1] }),
    ).rejects.toBeInstanceOf(ConnectionError)
    expect(getMeMock).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry on UnauthorizedError — fails fast on bad key', async () => {
    getMeMock.mockRejectedValueOnce(
      new UnauthorizedError(errorResponse('UNAUTHORIZED', 'bad key'), 401),
    )
    await expect(
      bootClient(env, silentLogger, { maxAttempts: 5, backoffMs: [1, 1, 1, 1] }),
    ).rejects.toBeInstanceOf(UnauthorizedError)
    expect(getMeMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on other non-network errors', async () => {
    getMeMock.mockRejectedValueOnce(new Error('something else'))
    await expect(
      bootClient(env, silentLogger, { maxAttempts: 5, backoffMs: [1, 1, 1, 1] }),
    ).rejects.toThrow('something else')
    expect(getMeMock).toHaveBeenCalledTimes(1)
  })
})
