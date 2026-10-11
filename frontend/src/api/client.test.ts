import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './client'

afterEach(() => vi.unstubAllGlobals())

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected a failure')
}

describe('ApiError kinds', () => {
  it('a lost connection on an order is an unclear outcome, not a plain failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const e = await failure(api.placeOrder({ symbol: 'EURUSD', side: 'buy', order_type: 'market', volume: 0.1 }))
    expect(e.kind).toBe('unknown')
    expect(e.message).toMatch(/may or may not/)
  })

  it('a lost connection on a read is just unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const e = await failure(api.positions())
    expect(e.kind).toBeUndefined()
  })

  it.each([
    [409, { detail: 'Requote', kind: 'broker', retcode: 10004 }, 'broker'],
    [422, { detail: 'Rate limit', kind: 'risk', violations: ['Rate limit'] }, 'risk'],
    [503, { detail: 'No clear answer', kind: 'unknown', retcode: null }, 'unknown'],
    [502, { detail: 'positions_get failed' }, undefined],
  ])('reads kind from a %s reply', async (status, body, kind) => {
    vi.stubGlobal('fetch', reply(status, body))
    const e = await failure(api.cancelOrder(1))
    expect(e.status).toBe(status)
    expect(e.kind).toBe(kind)
  })
})
