import { describe, expect, it } from 'vitest'
import { Semaphore } from '../src/semaphore.js'

describe('Semaphore', () => {
  it('rejects non-positive max in constructor', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
    expect(() => new Semaphore(1.5)).toThrow()
  })

  it('acquires immediately when below capacity', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    await sem.acquire()
    expect(sem.inFlight).toBe(2)
    expect(sem.waiting).toBe(0)
  })

  it('queues acquire calls past capacity, releases in FIFO order', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    expect(sem.inFlight).toBe(1)

    const order: string[] = []
    const a = sem.acquire().then(() => order.push('a'))
    const b = sem.acquire().then(() => order.push('b'))
    const c = sem.acquire().then(() => order.push('c'))

    // Let the .then continuations register
    await Promise.resolve()
    expect(sem.waiting).toBe(3)

    sem.release()
    await a
    expect(order).toEqual(['a'])

    sem.release()
    await b
    expect(order).toEqual(['a', 'b'])

    sem.release()
    await c
    expect(order).toEqual(['a', 'b', 'c'])

    sem.release()
    expect(sem.inFlight).toBe(0)
    expect(sem.waiting).toBe(0)
  })

  it('throws if release is called without a matching acquire', () => {
    const sem = new Semaphore(1)
    expect(() => sem.release()).toThrow()
  })

  it('lets a previously-blocked acquire proceed after a release', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    let acquired = false
    const queued = sem.acquire().then(() => {
      acquired = true
    })

    await Promise.resolve()
    expect(acquired).toBe(false)

    sem.release()
    await queued
    expect(acquired).toBe(true)
    expect(sem.inFlight).toBe(1)
  })
})
