import { describe, expect, it } from 'vitest'
import type { Candle } from '../api/types'
import { compute, defaultConfig, indicatorLabel, sanitize } from './indicatorConfig'

const candles: Candle[] = Array.from({ length: 60 }, (_, i) => ({
  time: i * 60, open: 1 + i / 100, high: 1.02 + i / 100, low: 0.99 + i / 100, close: 1.01 + i / 100, volume: 10,
}))

describe('indicator configs', () => {
  it('labels with parameters', () => {
    expect(indicatorLabel(defaultConfig('sma', 'a'))).toBe('SMA 20')
    expect(indicatorLabel(defaultConfig('bb', 'a'))).toBe('BB 20 2')
    expect(indicatorLabel(defaultConfig('macd', 'a'))).toBe('MACD 12 26 9')
    expect(indicatorLabel(defaultConfig('vwap', 'a'))).toBe('VWAP')
  })

  it('sanitizes params: clamps, fills defaults, drops extras', () => {
    expect(sanitize({ id: 'a', type: 'sma', params: [0], color: '#fff' }).params).toEqual([1])
    expect(sanitize({ id: 'a', type: 'bb', params: [NaN], color: '#fff' }).params).toEqual([20, 2])
    expect(sanitize({ id: 'a', type: 'rsi', params: [14, 99], color: '#fff' }).params).toEqual([14])
  })

  it('every indicator yields outputs aligned with the candles', () => {
    for (const type of ['sma', 'ema', 'bb', 'vwap', 'rsi', 'macd'] as const) {
      const outs = compute(defaultConfig(type, 'x'), candles)
      expect(outs.length).toBeGreaterThan(0)
      for (const o of outs) expect(o.values).toHaveLength(candles.length)
    }
  })

  it('MACD has a histogram plus two lines; BB has three lines', () => {
    expect(compute(defaultConfig('macd', 'x'), candles).map((o) => o.kind)).toEqual(['histogram', 'line', 'line'])
    expect(compute(defaultConfig('bb', 'x'), candles).map((o) => o.key)).toEqual(['upper', 'middle', 'lower'])
  })
})
