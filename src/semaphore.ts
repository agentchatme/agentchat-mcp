// ─── Bounded-concurrency semaphore ─────────────────────────────────────────
//
// Gates concurrent tool-handler entries against AGENTCHAT_MAX_CONCURRENT_TOOLS.
// Without this, an aggressive MCP host firing 100 parallel tool calls hits
// the AgentChat API with 100 simultaneous requests and burns the agent's
// per-second rate-limit budget faster than necessary, producing 429s the
// LLM has to interpret. With this semaphore, calls past the ceiling queue
// and run as soon as a slot frees — invisible to the host except for
// slightly higher per-call latency under burst.
//
// FIFO ordering is preserved: waiters are released in arrival order. A
// token released back into an empty queue immediately becomes available
// for the next acquire.

export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore max must be a positive integer, got ${max}`)
    }
  }

  /**
   * Acquire a slot. Resolves immediately if capacity is available; queues
   * otherwise and resolves when a slot frees.
   */
  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++
        resolve()
      })
    })
  }

  /**
   * Release a previously-acquired slot. Wakes the next waiter, if any.
   * Calling release without a matching acquire is a programming error and
   * will eventually let `active` go negative — guarded with an assertion.
   */
  release(): void {
    if (this.active === 0) {
      throw new Error('Semaphore.release() called without a matching acquire')
    }
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }

  /** Current count of holders. For metrics / debugging. */
  get inFlight(): number {
    return this.active
  }

  /** Number of waiters queued behind a full semaphore. For metrics / debugging. */
  get waiting(): number {
    return this.waiters.length
  }
}
