import {
  CandlestickSeries,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import { stream, useStream } from '../api/stream'
import { TIMEFRAMES, type Candle, type SymbolInfo, type Timeframe } from '../api/types'
import type { Theme } from '../hooks/useTheme'
import { mergeLive, prependOlder } from '../lib/candles'
import { price } from '../lib/format'
import { sanitize, type IndicatorConfig } from '../lib/indicatorConfig'
import { drawingPrefs, useDrawingPrefs } from '../lib/drawingPrefs'
import type { Drawing } from '../lib/drawings'
import { load, save } from '../lib/storage'
import { DrawingTools, IndicatorMenu } from './ChartTools'
import { DrawingSettings, DrawingStyleBar } from './DrawingStyle'
import { useConfirm } from './Confirm'
import { DrawingLayer, type Tool } from './DrawingLayer'
import { IndicatorSet, type LegendItem } from './IndicatorSet'
import { TradeLines } from './TradeLines'
import { useDrawings } from './useDrawings'
import { lineColors, useTradeLines } from './useTradeLines'

const INITIAL_BARS = 500
const PAGE_BARS = 500
const LOAD_MORE_THRESHOLD = 20 // bars left of the visible range before fetching more
const TF_SECONDS: Record<Timeframe, number> = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14_400, D1: 86_400 }
interface Props {
  /** Stable pane id: keys this chart's stream subscription. */
  id: string
  /** Where this pane's indicator setup is remembered. */
  indicatorsKey: string
  symbol: string
  info: SymbolInfo | undefined
  timeframe: Timeframe
  onTimeframe: (tf: Timeframe) => void
  theme: Theme
  /** With several charts: is this the one the watchlist and order ticket drive? */
  active?: boolean
  onActivate?: () => void
  /** Extra controls at the start of the header (e.g. the layout picker). */
  toolbar?: ReactNode
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
})

function toVolume(c: Candle): HistogramData<UTCTimestamp> {
  // CSS colour tokens are 6-digit hex, so a 2-digit alpha suffix works.
  return { time: c.time as UTCTimestamp, value: c.volume, color: cssVar(c.close >= c.open ? '--up' : '--down') + '55' }
}

export function Chart({ id, indicatorsKey, symbol, info, timeframe, onTimeframe, theme, active, onActivate, toolbar }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const linesRef = useRef<TradeLines | null>(null)
  const indicatorsRef = useRef<IndicatorSet | null>(null)
  const layerRef = useRef<DrawingLayer | null>(null)

  // Mutable series state lives in refs: it changes several times a second.
  const bars = useRef<Candle[]>([])
  const times = useRef<number[]>([]) // bar times, for mapping drawings onto the x axis
  const view = useRef({ symbol, timeframe, loadId: 0, loadingOlder: false, exhausted: false })

  const [hover, setHover] = useState<Candle | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [indicators, setIndicators] = useState<IndicatorConfig[]>(() =>
    load<IndicatorConfig[]>(indicatorsKey, []).map(sanitize),
  )
  const [tool, setTool] = useState<Tool>('cursor')
  const [selectedDrawing, setSelectedDrawing] = useState<Drawing | null>(null)
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [drawingCount, setDrawingCount] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const prefs = useDrawingPrefs()
  const pip = useRef(0.0001)
  const accent = useRef('#4d86ff')
  const { confirm } = useConfirm()
  const [last, setLast] = useState<Candle | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string>()

  // --- create chart once ---------------------------------------------------
  useEffect(() => {
    const el = containerRef.current!
    const chart = createChart(el, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 8 },
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.22 } },
      // Required by the library's Apache-2.0 NOTICE (link to its authors).
      layout: { attributionLogo: true },
    })
    const candles = chart.addSeries(CandlestickSeries, { borderVisible: false })
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    chart.subscribeCrosshairMove((param) => {
      const c = param.seriesData.get(candles) as CandlestickData | undefined
      const v = param.seriesData.get(volume) as HistogramData | undefined
      setHover(c && param.time ? { time: Number(param.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: v?.value ?? 0 } : null)
      setHoverIndex(c && param.logical !== undefined ? Math.round(param.logical) : null)
    })

    const onRange = (range: LogicalRange | null) => {
      if (range && range.from < LOAD_MORE_THRESHOLD) void loadOlder()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    // Draggable entry / SL / TP lines for positions, pending orders and the order draft.
    const lines = new TradeLines(el, candles, lineColors(), 5)
    // Created after the trade lines so their pointer handlers run first and win overlaps.
    const layer = new DrawingLayer(
      el, chart, candles,
      () => bars.current,
      () => times.current,
      () => TF_SECONDS[view.current.timeframe],
      () => pip.current,
      id,
    )
    layer.onToolChange = setTool
    layer.onSelect = (d) => {
      setSelectedDrawing(d)
      setDrawingCount(layer.getDrawings().length)
      if (!d) setSettingsOpen(false)
    }
    layer.onCreate = (d) => setJustCreated(d.id)
    const indicatorSet = new IndicatorSet(chart)

    chartRef.current = chart
    candleRef.current = candles
    volumeRef.current = volume
    linesRef.current = lines
    layerRef.current = layer
    indicatorsRef.current = indicatorSet
    if (import.meta.env.DEV) {
      // Test hook for browser automation: where is a price on screen? Not in production builds.
      const w = window as unknown as Record<string, Record<string, unknown> | undefined>
      const hook = {
        priceToY: (p: number) => candles.priceToCoordinate(p),
        visibleRange: () => chart.timeScale().getVisibleLogicalRange(),
        panes: () => chart.panes().length,
      }
      w.__pipdeskCharts = { ...w.__pipdeskCharts, [id]: hook }
      if (id === '0') w.__pipdeskChart = hook
    }
    return () => {
      lines.destroy()
      layer.destroy()
      indicatorSet.destroy()
      linesRef.current = null
      layerRef.current = null
      indicatorsRef.current = null
      chart.remove()
      chartRef.current = candleRef.current = volumeRef.current = null
    }
  }, [])

  useTradeLines(linesRef, symbol, info, theme)
  useDrawings(layerRef, symbol, id, prefs.sync)

  /** Restyle the selected drawing; its look becomes the default for that type. */
  const editDrawing = (patch: Partial<Drawing>) => {
    const d = layerRef.current?.getDrawings().find((x) => x.id === selectedDrawing?.id)
    if (!d) return
    layerRef.current?.updateSelected(patch)
    const { points: _, locked: __, text: ___, ...style } = patch
    drawingPrefs.remember(d.type, style)
  }

  /** After bars were replaced or prepended: recompute everything derived from them. */
  const barsChanged = () => {
    times.current = bars.current.map((c) => c.time)
    indicatorsRef.current?.setData(bars.current)
    layerRef.current?.refresh()
  }

  // --- indicators ----------------------------------------------------------------
  useEffect(() => {
    save(indicatorsKey, indicators)
    indicatorsRef.current?.configure(indicators, bars.current)
  }, [indicators])

  // --- theme -----------------------------------------------------------------
  useEffect(() => {
    const up = cssVar('--up')
    const down = cssVar('--down')
    chartRef.current?.applyOptions({
      layout: { background: { color: cssVar('--panel') }, textColor: cssVar('--muted'), fontSize: 11 },
      grid: { vertLines: { color: cssVar('--line') + '80' }, horzLines: { color: cssVar('--line') + '80' } },
      rightPriceScale: { borderColor: cssVar('--line') },
      timeScale: { borderColor: cssVar('--line') },
    })
    candleRef.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down })
    volumeRef.current?.setData(bars.current.map(toVolume))
    indicatorsRef.current?.setColors(up, down, bars.current)
    accent.current = cssVar('--accent')
    layerRef.current?.setColors({ accent: accent.current, up, down })
  }, [theme])

  // --- price precision follows the symbol -------------------------------------
  useEffect(() => {
    if (!info) return
    candleRef.current?.applyOptions({ priceFormat: { type: 'price', precision: info.digits, minMove: info.point } })
    indicatorsRef.current?.setDigits(info.digits)
    pip.current = info.digits === 3 || info.digits === 5 ? info.point * 10 : info.point
    layerRef.current?.refresh()
  }, [info])

  // --- (re)load history on symbol / timeframe change, and after any reconnect
  // (so bars missed while offline don't leave a gap) ---------------------------
  const online = useStream((s) => s.state === 'open' && s.status?.connected === true)
  useEffect(() => {
    if (!online) return
    const v = view.current
    const loadId = ++v.loadId
    Object.assign(v, { symbol, timeframe, loadingOlder: false, exhausted: false })
    bars.current = []
    times.current = []
    setStatus('loading')
    setHover(null)
    stream.setChart(id, symbol, timeframe)

    api.candles(symbol, timeframe, INITIAL_BARS).then(
      (r) => {
        if (loadId !== v.loadId) return
        bars.current = r.candles
        candleRef.current?.setData(r.candles.map(toBar))
        volumeRef.current?.setData(r.candles.map(toVolume))
        barsChanged()
        chartRef.current?.timeScale().scrollToRealTime()
        setLast(r.candles.at(-1) ?? null)
        setStatus('ready')
      },
      (e: Error) => {
        if (loadId !== v.loadId) return
        setError(e.message)
        setStatus('error')
      },
    )
  }, [id, symbol, timeframe, online])

  useEffect(() => () => stream.setChart(id, null, 'M15'), [id]) // stop streaming when the pane closes

  // --- live forming candle ----------------------------------------------------
  useEffect(
    () =>
      stream.on('candle', (m) => {
        const v = view.current
        if (m.symbol !== v.symbol || m.timeframe !== v.timeframe) return
        const applied = mergeLive(bars.current, m.candles)
        for (const c of applied) {
          candleRef.current?.update(toBar(c))
          volumeRef.current?.update(toVolume(c))
        }
        if (applied.length) {
          if (bars.current.length !== times.current.length) times.current = bars.current.map((c) => c.time)
          indicatorsRef.current?.update(bars.current, applied.length)
        }
        setLast(bars.current.at(-1) ?? null)
      }),
    [],
  )

  // --- lazy-load older history when scrolled to the left edge ------------------
  async function loadOlder() {
    const v = view.current
    const first = bars.current[0]
    if (!first || v.loadingOlder || v.exhausted) return
    v.loadingOlder = true
    const loadId = v.loadId
    try {
      const r = await api.candles(v.symbol, v.timeframe, PAGE_BARS, first.time)
      if (loadId !== v.loadId) return
      const ts = chartRef.current?.timeScale()
      const range = ts?.getVisibleLogicalRange()
      const added = prependOlder(bars.current, r.candles)
      if (added === 0) {
        v.exhausted = true
        return
      }
      candleRef.current?.setData(bars.current.map(toBar))
      volumeRef.current?.setData(bars.current.map(toVolume))
      barsChanged()
      // Keep the view where it was: logical indexes shifted by `added`.
      if (ts && range) ts.setVisibleLogicalRange({ from: range.from + added, to: range.to + added })
    } catch {
      // transient; the next scroll retries
    } finally {
      if (loadId === v.loadId) v.loadingOlder = false
    }
  }

  const tick = useStream((s) => s.ticks[symbol])
  const shown = hover ?? last
  const digits = info?.digits ?? 5

  return (
    <div
      className={`@container flex h-full flex-col ${active ? 'outline outline-1 -outline-offset-1 outline-accent/60' : ''}`}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1">
        {toolbar && (
          <>
            {toolbar}
            <span className="h-5 w-px bg-line" />
          </>
        )}
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{symbol}</span>
          <span className="hidden text-muted @3xl:inline">{info?.description}</span>
        </div>
        <div className="flex overflow-hidden rounded border border-line" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => onTimeframe(tf)}
              aria-pressed={tf === timeframe}
              className={`px-2 py-0.5 text-[12px] ${tf === timeframe ? 'bg-accent text-white' : 'text-muted hover:bg-panel-2 hover:text-fg'}`}
            >
              {tf}
            </button>
          ))}
        </div>
        <IndicatorMenu configs={indicators} onChange={setIndicators} />
        <span className="h-5 w-px bg-line" />
        <DrawingTools
          tool={tool}
          onTool={(t) => layerRef.current?.setTool(t)}
          hasSelection={selectedDrawing !== null}
          count={drawingCount}
          onDelete={() => layerRef.current?.deleteSelected()}
          onClear={() =>
            void confirm({
              title: prefs.sync ? `Remove all drawings on ${symbol}?` : `Remove this chart's drawings on ${symbol}?`,
              tone: 'danger',
              always: true,
              confirmLabel: 'Remove all',
              run: async () => layerRef.current?.clear(),
            })
          }
        />
        {tick && (
          <div className="num ml-auto flex items-center gap-3 text-[12px]">
            <span className="text-down">{price(tick.bid, digits)}</span>
            <span className="text-muted">{info ? ((tick.ask - tick.bid) / info.point).toFixed(0) : ''}</span>
            <span className="text-up">{price(tick.ask, digits)}</span>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />
        {selectedDrawing && (
          <DrawingStyleBar
            drawing={selectedDrawing}
            accent={accent.current}
            focusText={justCreated === selectedDrawing.id}
            onChange={editDrawing}
            onClone={() => layerRef.current?.cloneSelected()}
            onDelete={() => layerRef.current?.deleteSelected()}
            onSettings={() => setSettingsOpen(true)}
          />
        )}
        {selectedDrawing && settingsOpen && (
          <DrawingSettings
            drawing={selectedDrawing}
            accent={accent.current}
            digits={digits}
            step={info?.point ?? 0.00001}
            onChange={editDrawing}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {shown && (
          <Legend bar={shown} digits={digits} items={indicatorsRef.current?.legend(hover ? hoverIndex : null) ?? []} />
        )}
        {status !== 'ready' && (
          <div className="absolute inset-0 grid place-items-center bg-panel/60 text-muted">
            {status === 'loading' ? 'Loading…' : <span className="text-down">{error}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function Legend({ bar, digits, items }: { bar: Candle; digits: number; items: LegendItem[] }) {
  const change = bar.close - bar.open
  const tone = change >= 0 ? 'text-up' : 'text-down'
  const item = (label: string, value: number) => (
    <span>
      <span className="text-muted">{label}</span> <span className={tone}>{price(value, digits)}</span>
    </span>
  )
  return (
    <div className="num pointer-events-none absolute top-2 left-3 z-10 flex flex-col gap-0.5 text-[11px]">
      <div className="flex gap-3">
      {item('O', bar.open)}
      {item('H', bar.high)}
      {item('L', bar.low)}
      {item('C', bar.close)}
      <span className={tone}>
        {change >= 0 ? '+' : ''}
        {price(change, digits)} ({((change / bar.open) * 100).toFixed(2)}%)
      </span>
      <span>
        <span className="text-muted">Vol</span> {bar.volume.toLocaleString()}
      </span>
      </div>
      {items.map((it) => (
        <div key={it.id} className="flex gap-2">
          <span style={{ color: it.color }}>{it.label}</span>
          {it.values.map((v) => (
            <span key={v.label}>
              {v.label && <span className="text-muted">{v.label} </span>}
              {v.value === null ? '—' : price(v.value, it.decimals ?? digits)}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
