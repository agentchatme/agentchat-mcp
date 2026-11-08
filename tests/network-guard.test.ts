import * as http from 'node:http'
import * as net from 'node:net'
import { AgentChatClient } from 'agentchatme'
import { describe, expect, it } from 'vitest'
import { isLoopbackHost, NetworkBlockedError, takeBlockedAttempts } from './setup/network-guard.js'

// The guard itself (tests/setup/network-guard.ts): every test file runs
// under it, so a test that forgets to stub the network fails instead of
// talking to a real server.

describe('network guard', () => {
  it('refuses fetch to a non-loopback host, and records the attempt', async () => {
    await expect(fetch('https://api.agentchat.me/v1/inbox')).rejects.toBeInstanceOf(NetworkBlockedError)
    expect(takeBlockedAttempts()).toEqual(['https://api.agentchat.me/v1/inbox'])
  })

  it('refuses an SDK client built without its own fetch (it captures the guarded global)', async () => {
    const client = new AgentChatClient({
      apiKey: 'ac_test_0123456789abcdef0123456789abcdef',
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
    })
    await expect(client.getMe()).rejects.toThrow(/network-guard/)
    expect(takeBlockedAttempts()).toEqual(['https://api.agentchat.me/v1/agents/me'])
  })

  it('refuses a raw socket to a non-loopback host, in every argument form', () => {
    expect(() => net.connect({ host: 'example.com', port: 443 })).toThrow(NetworkBlockedError)
    expect(() => net.connect(443, 'example.com')).toThrow(NetworkBlockedError)
    expect(() => new net.Socket().connect({ host: '8.8.8.8', port: 53 })).toThrow(NetworkBlockedError)
    expect(takeBlockedAttempts()).toEqual(['socket example.com', 'socket example.com', 'socket 8.8.8.8'])
  })

  it('leaves loopback open: a local server answers fetch', async () => {
    const server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as net.AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(await res.text()).toBe('ok')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    expect(takeBlockedAttempts()).toEqual([])
  })

  it('classifies loopback hosts', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['api.agentchat.me', 'api.agentchat.test', '10.0.0.1', '::ffff:8.8.8.8', 'example.com']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})
