import type { Candle } from '../api/types'
import { bollinger, ema, macd, rsi, sma, vwap, type Series } from './indicators'

export type IndicatorType = 'sma' | 'ema' | 'bb' | 'vwap' | 'rsi' | 'macd'

export interface IndicatorConfig {
  id: string
  type: IndicatorType
  params: number[]
  color: string
}

interface ParamMeta {
  label: string
  default: number
  min: number
  max: number
  step?: number
}

export const INDICATORS: Record<IndicatorType, { name: string; pane: 'main' | 'own'; params: ParamMeta[]; color: string }> = {
  sma: { name: 'SMA', pane: 'main', params: [{ label: 'Period', default: 20, min: 1, max: 500 }], color: '#f59e0b' },
  ema: { name: 'EMA', pane: 'main', params: [{ label: 'Period', default: 50, min: 1, max: 500 }], color: '#a855f7' },
  bb: {
    name: 'Bollinger Bands',
    pane: 'main',
    params: [
      { label: 'Period', default: 20, min: 2, max: 500 },
      { label: 'Std dev', default: 2, min: 0.5, max: 5, step: 0.5 },
    ],
    color: '#38bdf8',
  },
  vwap: { name: 'VWAP', pane: 'main', params: [], color: '#ec4899' },
  rsi: { name: 'RSI', pane: 'own', params: [{ label: 'Period', default: 14, min: 2, max: 200 }], color: '#8b5cf6' },
  macd: {
    name: 'MACD',
    pane: 'own',
    params: [
      { label: 'Fast', default: 12, min: 1, max: 200 },
      { label: 'Slow', default: 26, min: 2, max: 400 },
      { label: 'Signal', default: 9, min: 1, max: 200 },
    ],
    color: '#3b82f6',
  },
}

export function defaultConfig(type: IndicatorType, id: string): IndicatorConfig {
  const meta = INDICATORS[type]
  return { id, type, params: meta.params.map((p) => p.default), color: meta.color }
}

export function indicatorLabel(cfg: IndicatorConfig): string {
  const name = cfg.type === 'bb' ? 'BB' : INDICATORS[cfg.type].name
  return cfg.params.length ? `${name} ${cfg.params.join(' ')}` : name
}

/** Clamp/repair params loaded from storage or typed by the user. */
export function sanitize(cfg: IndicatorConfig): IndicatorConfig {
  const meta = INDICATORS[cfg.type]
  const params = meta.params.map((p, i) => {
    const v = Number(cfg.params[i])
    return Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default
  })
  return { ...cfg, params }
}

export interface Output {
  key: string
  label: string
  kind: 'line' | 'histogram'
  values: Series
  color: string
  width: 1 | 2
  dashed?: boolean
}

/** All plotted series for one indicator. Pure. */
export function compute(cfg: IndicatorConfig, candles: readonly Candle[]): Output[] {
  const closes = candles.map((c) => c.close)
  const p = cfg.params
  switch (cfg.type) {
    case 'sma':
      return [{ key: 'sma', label: indicatorLabel(cfg), kind: 'line', values: sma(closes, p[0]!), color: cfg.color, width: 2 }]
    case 'ema':
      return [{ key: 'ema', label: indicatorLabel(cfg), kind: 'line', values: ema(closes, p[0]!), color: cfg.color, width: 2 }]
    case 'bb': {
      const b = bollinger(closes, p[0]!, p[1]!)
      return [
        { key: 'upper', label: 'Upper', kind: 'line', values: b.upper, color: cfg.color, width: 1 },
        { key: 'middle', label: 'Basis', kind: 'line', values: b.middle, color: cfg.color, width: 1, dashed: true },
        { key: 'lower', label: 'Lower', kind: 'line', values: b.lower, color: cfg.color, width: 1 },
      ]
    }
    case 'vwap':
      return [{ key: 'vwap', label: 'VWAP', kind: 'line', values: vwap(candles), color: cfg.color, width: 2 }]
    case 'rsi':
      return [{ key: 'rsi', label: indicatorLabel(cfg), kind: 'line', values: rsi(closes, p[0]!), color: cfg.color, width: 2 }]
    case 'macd': {
      const m = macd(closes, p[0]!, p[1]!, p[2]!)
      return [
        { key: 'hist', label: 'Hist', kind: 'histogram', values: m.histogram, color: cfg.color, width: 1 },
        { key: 'macd', label: 'MACD', kind: 'line', values: m.macd, color: cfg.color, width: 2 },
        { key: 'signal', label: 'Signal', kind: 'line', values: m.signal, color: '#f97316', width: 1 },
      ]
    }
  }
}
