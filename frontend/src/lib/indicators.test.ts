import { describe, expect, it } from 'vitest'
import type { Candle } from '../api/types'
import { bollinger, ema, macd, rsi, sma, vwap } from './indicators'

const close = (s: (number | null)[], digits = 2) => s.map((v) => (v === null ? null : Number(v.toFixed(digits))))

describe('sma', () => {
  it('averages a sliding window', () => {
    expect(sma([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5])
  })
  it('handles short input and period 1', () => {
    expect(sma([1, 2], 3)).toEqual([null, null])
    expect(sma([4, 5], 1)).toEqual([4, 5])
  })
})

describe('ema', () => {
  it('seeds with the SMA, then smooths with k = 2/(n+1)', () => {
    // period 3, k = 0.5: seed (1+2+3)/3 = 2, then 4*.5+2*.5 = 3, 5*.5+3*.5 = 4, 6*.5+4*.5 = 5
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5])
  })
  it('matches a hand-computed 10-period example', () => {
    const v = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39]
    const e = ema(v, 10)
    expect(e[9]).toBeCloseTo(22.221, 3) // SMA seed
    expect(e[10]).toBeCloseTo(22.208, 3)
    expect(e[11]).toBeCloseTo(22.241, 3)
  })
  it('skips nulls in the input', () => {
    expect(ema([null, null, 1, 2, 3, 4], 2)).toEqual([null, null, null, 1.5, 2.5, 3.5])
  })
})

describe('bollinger', () => {
  it('uses the population standard deviation', () => {
    // Classic set: mean 5, population sd 2
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2)
    expect(b.middle[7]).toBe(5)
    expect(b.upper[7]).toBe(9)
    expect(b.lower[7]).toBe(1)
    expect(b.upper[6]).toBeNull()
  })
  it('collapses to the mean on a flat series', () => {
    const b = bollinger([3, 3, 3, 3], 2, 2)
    expect(b.upper[3]).toBe(3)
    expect(b.lower[3]).toBe(3)
  })
})

describe('rsi', () => {
  // StockCharts' worked example (14-period Wilder RSI)
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
    46.03, 46.41, 46.22, 45.64,
  ]
  it('matches the reference values', () => {
    const r = rsi(closes, 14)
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true)
    // By hand: first 14 changes gain 3.34 and lose 1.40 → avg 0.23857 / 0.10000 → RS 2.3857 → RSI 70.46.
    // (StockCharts' table shows 70.53 because its spreadsheet rounds the averages to 2 dp first.)
    expect(r[14]).toBeCloseTo(100 - 100 / (1 + 3.34 / 1.4), 10)
    expect(close(r.slice(14), 2)).toEqual([70.46, 66.25, 66.48, 69.35, 66.29, 57.92])
  })
  it('is 100 when there are no losses, 50 when flat', () => {
    expect(rsi([1, 2, 3, 4, 5], 3)[4]).toBe(100)
    expect(rsi([2, 2, 2, 2], 2)[3]).toBe(50)
  })
  it('stays within 0..100', () => {
    const r = rsi([5, 4, 3, 2, 1, 2, 1, 0.5], 3)
    expect(r.filter((v): v is number => v !== null).every((v) => v >= 0 && v <= 100)).toBe(true)
  })
})

describe('macd', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.1)
  const m = macd(values, 12, 26, 9)
  it('MACD = EMA(12) − EMA(26), starting at the slow EMA', () => {
    const f = ema(values, 12)
    const s = ema(values, 26)
    expect(m.macd[24]).toBeNull()
    expect(m.macd[25]).toBeCloseTo(f[25]! - s[25]!, 10)
    expect(m.macd[59]).toBeCloseTo(f[59]! - s[59]!, 10)
  })
  it('signal = EMA(9) of the MACD line; histogram = MACD − signal', () => {
    expect(m.signal[32]).toBeNull()
    expect(m.signal[33]).toBeCloseTo(m.macd.slice(25, 34).reduce((a, b) => a! + b!, 0)! / 9, 10)
    expect(m.histogram[40]).toBeCloseTo(m.macd[40]! - m.signal[40]!, 10)
  })
})

describe('vwap', () => {
  const c = (time: number, h: number, l: number, cl: number, volume: number): Candle => ({ time, open: cl, high: h, low: l, close: cl, volume })
  it('weights typical price by volume and resets at the session boundary', () => {
    const day = 86_400
    const candles = [c(0, 12, 9, 9, 100), c(60, 15, 12, 12, 300), c(day, 30, 30, 30, 5)]
    const v = vwap(candles)
    expect(v[0]).toBe(10) // (12+9+9)/3
    expect(v[1]).toBe((10 * 100 + 13 * 300) / 400)
    expect(v[2]).toBe(30) // new day
  })
  it('falls back to typical price with zero volume', () => {
    expect(vwap([c(0, 3, 1, 2, 0)])[0]).toBe(2)
  })
})
