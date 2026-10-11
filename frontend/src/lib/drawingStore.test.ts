import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrawingStore, mergePane, visibleOn, type DrawingBackend } from './drawingStore'
import type { Drawing } from './drawings'

const line = (id: string, price = 1, pane?: string): Drawing => ({ id, type: 'hline', points: [{ time: 0, price }], ...(pane && { pane }) })

function setup(saved: Record<string, Drawing[]> = {}) {
  let resolveLoad: (() => void) | undefined
  const backend = {
    load: vi.fn((symbol: string) => new Promise<Drawing[]>((r) => (resolveLoad = () => r(saved[symbol] ?? [])))),
    save: vi.fn(() => Promise.resolve()),
    onSaveError: vi.fn(),
    onLoadError: vi.fn(),
  } satisfies DrawingBackend
  const store = new DrawingStore(backend, 100)
  const loaded = async () => {
    resolveLoad?.()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { backend, store, loaded }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DrawingStore', () => {
  it('loads once per symbol and shares the drawings with every subscriber', async () => {
    const { backend, store, loaded } = setup({ EURUSD: [line('a')] })
    const m5 = vi.fn()
    const h1 = vi.fn()
    store.subscribe('EURUSD', m5)
    store.subscribe('EURUSD', h1)
    await loaded()
    expect(backend.load).toHaveBeenCalledTimes(1)
    expect(m5).toHaveBeenCalledWith([line('a')], null)
    expect(h1).toHaveBeenCalledWith([line('a')], null)
  })

  it('pushes an edit to the other charts and saves it once, debounced', async () => {
    const { backend, store, loaded } = setup()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe('EURUSD', a)
    store.subscribe('EURUSD', b)
    await loaded()
    store.set('EURUSD', [line('x')], 'chart-a')
    store.set('EURUSD', [line('x', 2)], 'chart-a')
    expect(b).toHaveBeenLastCalledWith([line('x', 2)], 'chart-a')
    expect(backend.save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(backend.save).toHaveBeenCalledTimes(1)
    expect(backend.save).toHaveBeenCalledWith('EURUSD', [line('x', 2)])
  })

  it('merges edits made while loading instead of overwriting them', async () => {
    const { backend, store, loaded } = setup({ EURUSD: [line('saved')] })
    store.subscribe('EURUSD', () => {})
    store.set('EURUSD', [line('new')], 'chart')
    expect(backend.save).not.toHaveBeenCalled()
    await loaded()
    expect(store.get('EURUSD')).toEqual([line('saved'), line('new')])
    vi.advanceTimersByTime(100)
    expect(backend.save).toHaveBeenCalledWith('EURUSD', [line('saved'), line('new')])
  })

  it('flushes and forgets a symbol when its last chart leaves', async () => {
    const { backend, store, loaded } = setup()
    const off1 = store.subscribe('EURUSD', () => {})
    const off2 = store.subscribe('EURUSD', () => {})
    await loaded()
    store.set('EURUSD', [line('x')], 'chart')
    off1()
    expect(backend.save).not.toHaveBeenCalled()
    off2()
    expect(backend.save).toHaveBeenCalledTimes(1)
    expect(store.get('EURUSD')).toEqual([])
    store.subscribe('EURUSD', () => {})
    expect(backend.load).toHaveBeenCalledTimes(2)
  })

  it('never saves after a failed load', async () => {
    const backend: DrawingBackend = {
      load: () => Promise.reject(new Error('down')),
      save: vi.fn(() => Promise.resolve()),
      onSaveError: vi.fn(),
      onLoadError: vi.fn(),
    }
    const store = new DrawingStore(backend, 100)
    store.subscribe('EURUSD', () => {})
    await Promise.resolve()
    await Promise.resolve()
    store.set('EURUSD', [line('x')], 'chart')
    vi.advanceTimersByTime(1000)
    store.flush()
    expect(backend.onLoadError).toHaveBeenCalled()
    expect(backend.save).not.toHaveBeenCalled()
  })
})

describe('drawing sync setting', () => {
  const all = [line('old'), line('a', 1, '0'), line('b', 1, '1')]

  it('synced: every pane shows every drawing', () => {
    expect(all.filter((d) => visibleOn(d, '1', true))).toEqual(all)
  })

  it('not synced: a pane shows its own drawings and ones made before panes were recorded', () => {
    expect(all.filter((d) => visibleOn(d, '1', false)).map((d) => d.id)).toEqual(['old', 'b'])
  })

  it("not synced: a pane's edit keeps the other panes' drawings", () => {
    const shown = [line('b', 2, '1'), line('c', 1, '1')]
    expect(mergePane(all, shown, '1', false).map((d) => d.id)).toEqual(['a', 'b', 'c'])
    expect(mergePane(all, shown, '1', true)).toEqual(shown)
  })
})
