import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type WhitespaceData,
  type HistogramData,
  type LineData,
} from 'lightweight-charts'
import type { Candle } from '../api/types'
import { compute, INDICATORS, indicatorLabel, type IndicatorConfig, type Output } from '../lib/indicatorConfig'

// Relative pane heights: the price pane gets 3 parts, each indicator pane 1.
const MAIN_STRETCH = 3

interface Entry {
  cfg: IndicatorConfig
  series: ISeriesApi<'Line' | 'Histogram'>[]
  outputs: Output[]
}

export interface LegendItem {
  id: string
  label: string
  color: string
  /** Fixed decimals (e.g. RSI); otherwise the symbol's price digits. */
  decimals?: number
  values: { label: string; value: number | null }[]
}

/**
 * Owns the chart series for the active indicators. Overlays (SMA, EMA, BB, VWAP)
 * share the price pane; RSI and MACD each get their own pane below it.
 */
export class IndicatorSet {
  private entries: Entry[] = []
  private colors = { up: '#20b58a', down: '#f0555d' }
  private digits = 5

  constructor(private readonly chart: IChartApi) {}

  setColors(up: string, down: string, candles: readonly Candle[]): void {
    this.colors = { up, down }
    this.setData(candles)
  }

  /** Rebuild all series for a new indicator list. */
  configure(configs: IndicatorConfig[], candles: readonly Candle[]): void {
    for (const e of this.entries) for (const s of e.series) this.chart.removeSeries(s)
    this.entries = []
    this.removeEmptyPanes()

    let nextPane = 1
    for (const cfg of configs) {
      const pane = INDICATORS[cfg.type].pane === 'own' ? nextPane++ : 0
      const outputs = compute(cfg, candles)
      const series = outputs.map((o) => this.addSeries(o, pane))
      if (cfg.type === 'rsi') {
        for (const level of [70, 30]) {
          series[0]!.createPriceLine({ price: level, color: cfg.color + '80', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
        }
      }
      this.entries.push({ cfg, series, outputs })
    }
    for (const p of this.chart.panes()) p.setStretchFactor(p.paneIndex() === 0 ? MAIN_STRETCH : 1)
    this.applyPrecision()
    this.setData(candles)
  }

  /** Price precision follows the symbol (MACD gets one extra digit; RSI is 0–100). */
  setDigits(digits: number): void {
    this.digits = digits
    this.applyPrecision()
  }

  private applyPrecision(): void {
    for (const e of this.entries) {
      const precision = e.cfg.type === 'rsi' ? 2 : e.cfg.type === 'macd' ? this.digits + 1 : this.digits
      for (const s of e.series) s.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } })
    }
  }

  /** Full recompute, e.g. after loading or prepending history. */
  setData(candles: readonly Candle[]): void {
    for (const e of this.entries) {
      e.outputs = compute(e.cfg, candles)
      e.outputs.forEach((o, i) => e.series[i]!.setData(candles.map((c, j) => this.point(o, c.time, o.values[j] ?? null))))
    }
  }

  /** Live update: recompute and push the last `n` points (the bars that just changed). */
  update(candles: readonly Candle[], n: number): void {
    if (n <= 0) return
    for (const e of this.entries) {
      e.outputs = compute(e.cfg, candles)
      e.outputs.forEach((o, i) => {
        for (let j = Math.max(0, candles.length - n); j < candles.length; j++) {
          e.series[i]!.update(this.point(o, candles[j]!.time, o.values[j] ?? null))
        }
      })
    }
  }

  /** Values at a bar index (crosshair) or the latest bar, for the legend. */
  legend(index: number | null): LegendItem[] {
    return this.entries.map((e) => {
      const at = (o: Output) => {
        const i = index ?? o.values.length - 1
        return i >= 0 && i < o.values.length ? (o.values[i] ?? null) : null
      }
      return {
        id: e.cfg.id,
        label: indicatorLabel(e.cfg),
        color: e.cfg.color,
        decimals: e.cfg.type === 'rsi' ? 2 : undefined,
        values: e.outputs.length === 1 ? [{ label: '', value: at(e.outputs[0]!) }] : e.outputs.map((o) => ({ label: o.label, value: at(o) })),
      }
    })
  }

  destroy(): void {
    for (const e of this.entries) for (const s of e.series) this.chart.removeSeries(s)
    this.entries = []
  }

  private addSeries(o: Output, pane: number): ISeriesApi<'Line' | 'Histogram'> {
    if (o.kind === 'histogram') {
      return this.chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane)
    }
    return this.chart.addSeries(
      LineSeries,
      {
        color: o.color,
        lineWidth: o.width,
        lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: pane > 0,
        crosshairMarkerVisible: false,
      },
      pane,
    )
  }

  private point(o: Output, time: number, value: number | null): LineData | HistogramData | WhitespaceData {
    const t = time as UTCTimestamp
    if (value === null || !Number.isFinite(value)) return { time: t }
    if (o.kind === 'histogram') return { time: t, value, color: (value >= 0 ? this.colors.up : this.colors.down) + '99' }
    return { time: t, value }
  }

  private removeEmptyPanes(): void {
    const panes = this.chart.panes()
    for (let i = panes.length - 1; i > 0; i--) {
      if (panes[i]!.getSeries().length === 0) this.chart.removePane(i)
    }
  }
}
