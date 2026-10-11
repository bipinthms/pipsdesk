import { describe, expect, it } from 'vitest'
import { InFlight } from './inflight'

function deferred() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('InFlight', () => {
  it('drops a second run of the same action while the first is in flight', async () => {
    const f = new InFlight()
    const d = deferred()
    let calls = 0
    const send = () => {
      calls++
      return d.promise
    }
    const first = f.run('order', send)
    const second = f.run('order', send) // double-click
    expect(await second).toBe(false)
    expect(f.has('order')).toBe(true)
    d.resolve()
    expect(await first).toBe(true)
    expect(calls).toBe(1)
    expect(f.has('order')).toBe(false)
  })

  it('does not hold up a different action', async () => {
    const f = new InFlight()
    const d = deferred()
    const order = f.run('order', () => d.promise)
    expect(await f.run('close:42', async () => {})).toBe(true)
    d.resolve()
    await order
  })

  it('releases the action after a failure and rethrows', async () => {
    const f = new InFlight()
    await expect(f.run('order', async () => Promise.reject(new Error('Rejected: requote')))).rejects.toThrow('requote')
    expect(await f.run('order', async () => {})).toBe(true)
  })
})
