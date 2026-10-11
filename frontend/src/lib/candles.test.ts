import { describe, expect, it } from 'vitest'
import type { Candle } from '../api/types'
import { mergeLive, prependOlder } from './candles'

const bar = (time: number, close = 1, volume = 1): Candle => ({ time, open: 1, high: 2, low: 0.5, close, volume })

describe('mergeLive', () => {
  it('updates the forming bar in place', () => {
    const bars = [bar(60), bar(120)]
    const applied = mergeLive(bars, [bar(60), bar(120, 1.5, 3)])
    expect(applied).toEqual([bar(120, 1.5, 3)])
    expect(bars).toEqual([bar(60), bar(120, 1.5, 3)])
  })

  it('finalises the previous bar then appends the new one on rollover', () => {
    const bars = [bar(60), bar(120)]
    const applied = mergeLive(bars, [bar(120, 1.2), bar(180, 1.3)])
    expect(applied.map((c) => c.time)).toEqual([120, 180])
    expect(bars.map((c) => c.time)).toEqual([60, 120, 180])
    expect(bars[1]!.close).toBe(1.2)
  })

  it('ignores unchanged and stale bars', () => {
    const bars = [bar(60), bar(120)]
    expect(mergeLive(bars, [bar(0), bar(60, 9), bar(120)])).toEqual([])
    expect(bars).toEqual([bar(60), bar(120)])
  })

  it('does nothing before history has loaded', () => {
    const bars: Candle[] = []
    expect(mergeLive(bars, [bar(60)])).toEqual([])
    expect(bars).toEqual([])
  })
})

describe('prependOlder', () => {
  it('prepends only bars strictly older than the first', () => {
    const bars = [bar(180), bar(240)]
    expect(prependOlder(bars, [bar(60), bar(120), bar(180)])).toBe(2)
    expect(bars.map((c) => c.time)).toEqual([60, 120, 180, 240])
  })

  it('reports zero when history is exhausted', () => {
    const bars = [bar(180)]
    expect(prependOlder(bars, [])).toBe(0)
  })
})
