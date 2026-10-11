// Technical indicators, computed client-side. Pure functions: every output array
// is aligned index-for-index with the input, with `null` where there isn't enough
// data yet.

import type { Candle } from '../api/types'

export type Series = (number | null)[]

/** Simple moving average. */
export function sma(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= period) sum -= values[i - period]!
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/**
 * Exponential moving average (k = 2 / (period + 1)), seeded with the SMA of the
 * first `period` values. Null inputs are skipped (used for MACD's signal line).
 */
export function ema(values: readonly (number | null)[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1) return out
  const k = 2 / (period + 1)
  let seen = 0
  let seedSum = 0
  let prev: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v === null || v === undefined) continue
    if (prev === null) {
      seedSum += v
      seen++
      if (seen === period) {
        prev = seedSum / period
        out[i] = prev
      }
      continue
    }
    prev = v * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export interface Bands {
  middle: Series
  upper: Series
  lower: Series
}

/** Bollinger Bands: SMA ± `mult` population standard deviations. */
export function bollinger(values: readonly number[], period = 20, mult = 2): Bands {
  const middle = sma(values, period)
  const upper: Series = new Array(values.length).fill(null)
  const lower: Series = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const m = middle[i]
    if (m === null || m === undefined) continue
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (values[j]! - m) ** 2
    const sd = Math.sqrt(sq / period)
    upper[i] = m + mult * sd
    lower[i] = m - mult * sd
  }
  return { middle, upper, lower }
}

/** Relative Strength Index with Wilder's smoothing. First value at index `period`. */
export function rsi(values: readonly number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null)
  if (period < 1 || values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!
    if (d > 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss))
  out[period] = value()
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = value()
  }
  return out
}

export interface Macd {
  macd: Series
  signal: Series
  histogram: Series
}

/** MACD line (fast EMA − slow EMA), its signal EMA, and the histogram (MACD − signal). */
export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const f = ema(values, fast)
  const s = ema(values, slow)
  const line: Series = values.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null))
  const signal = ema(line, signalPeriod)
  const histogram: Series = line.map((m, i) => (m != null && signal[i] != null ? m - signal[i]! : null))
  return { macd: line, signal, histogram }
}

/**
 * Volume-weighted average price of the typical price (H+L+C)/3, anchored to each
 * trading day. Candle times are MT5 server time, so days roll at server midnight.
 */
export function vwap(candles: readonly Candle[], sessionSeconds = 86_400): Series {
  const out: Series = new Array(candles.length).fill(null)
  let session = NaN
  let pv = 0
  let vol = 0
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!
    const s = Math.floor(c.time / sessionSeconds)
    if (s !== session) {
      session = s
      pv = 0
      vol = 0
    }
    const typical = (c.high + c.low + c.close) / 3
    pv += typical * c.volume
    vol += c.volume
    out[i] = vol > 0 ? pv / vol : typical
  }
  return out
}
