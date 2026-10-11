import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { Candle } from '../api/types'
import { drawingPrefs, initialStyle, TOOLS, type Tool } from '../lib/drawingPrefs'
import {
  channelLines,
  dragHandle,
  extendSegment,
  fibValue,
  handlesOf,
  hitTest,
  logicalToTime,
  moveDrawing,
  newId,
  PLACED_POINTS,
  POINT_COUNT,
  snapToBar,
  spanX,
  styleOf,
  timeToLogical,
  type Box,
  type Drawing,
  type DrawingType,
  type Hit,
  type Point,
  type Px,
  type ResolvedStyle,
} from '../lib/drawings'

export type { Tool }

const MIN_DRAG_PX = 4
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif'

export interface DrawingColors {
  accent: string
  up: string
  down: string
}

type DragState =
  | { mode: 'edit'; id: string; hit: Hit; original: Drawing; startLogical: number; startPrice: number; moved: boolean }

/** A drawing being placed: by dragging, or click by click; unplaced points follow the pointer. */
interface Creating {
  drawing: Drawing
  placed: number
  /** Where the button went down, while it's down. */
  press: { x: number; y: number } | null
}

function alpha(color: string, a: number): string {
  return color + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')
}

function duration(seconds: number): string {
  const s = Math.abs(seconds)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

function timeLabel(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

/**
 * The chart's drawings (lines, channels, Fibonacci, shapes, text, measuring and
 * position tools), painted on the price pane as a series primitive, with create /
 * select / drag / delete interactions, the magnet and per-drawing styles.
 *
 * Pointer events are taken in the capture phase on the chart container. A press
 * already claimed by the trade lines (`defaultPrevented`) is ignored, so dragging
 * an SL never grabs a drawing underneath it.
 *
 * With several charts on the page, keyboard shortcuts (Escape, Delete, Alt+key
 * tools) go to the one last interacted with, and selecting on one chart
 * deselects on the others.
 */
export class DrawingLayer implements ISeriesPrimitive<Time> {
  private static focused: DrawingLayer | null = null

  private drawings: Drawing[] = []
  private selected: string | null = null
  private creating: Creating | null = null
  private tool: Tool = 'cursor'
  private drag: DragState | null = null
  private cursorSet = false
  private requestUpdate: () => void = () => {}
  private readonly view: IPrimitivePaneView
  private colors: DrawingColors = { accent: '#4d86ff', up: '#20b58a', down: '#f0555d' }
  /** Measured extents of text drawings, from the last paint, for hit testing. */
  private textBoxes = new Map<string, Box>()
  private priceViews: ISeriesPrimitiveAxisView[] = []
  private timeViews: ISeriesPrimitiveAxisView[] = []
  private unsubscribePrefs: () => void

  /** Fired after any user edit, and while dragging one, with the full list (for syncing and saving). */
  onChange: (drawings: Drawing[]) => void = () => {}
  onToolChange: (tool: Tool) => void = () => {}
  /** The selected drawing, whenever it or the selection changes. */
  onSelect: (d: Drawing | null) => void = () => {}
  /** A drawing was just finished (e.g. to start editing a text). */
  onCreate: (d: Drawing) => void = () => {}

  constructor(
    private readonly el: HTMLElement,
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<'Candlestick'>,
    private readonly getBars: () => readonly Candle[],
    private readonly getTimes: () => readonly number[],
    private readonly getTfSeconds: () => number,
    /** Price of one pip, for the measuring tools. */
    private readonly getPip: () => number,
    /** This chart's pane id, stamped on new drawings. */
    private readonly pane: string,
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (t) => this.draw(t) }
    this.view = { zOrder: () => 'top', renderer: () => renderer }
    el.addEventListener('pointerdown', this.onDown, true)
    el.addEventListener('pointermove', this.onHover, true)
    window.addEventListener('keydown', this.onKey)
    this.unsubscribePrefs = drawingPrefs.subscribe(() => this.requestUpdate())
    series.attachPrimitive(this)
  }

  destroy(): void {
    this.el.removeEventListener('pointerdown', this.onDown, true)
    this.el.removeEventListener('pointermove', this.onHover, true)
    window.removeEventListener('keydown', this.onKey)
    this.unsubscribePrefs()
    this.stopDragListeners()
    if (DrawingLayer.focused === this) DrawingLayer.focused = null
    this.series.detachPrimitive(this)
  }

  // --- ISeriesPrimitive ---------------------------------------------------------

  attached({ requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = requestUpdate
  }

  detached(): void {
    this.requestUpdate = () => {}
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view]
  }

  updateAllViews(): void {
    this.priceViews = []
    this.timeViews = []
    if (drawingPrefs.get().hidden) return
    const fmt = this.series.priceFormatter()
    const items = this.creating ? [...this.drawings, this.creating.drawing] : this.drawings
    for (const d of items) {
      const s = styleOf(d, this.colors.accent)
      if (!s.showLabel) continue
      const a = d.points[0]!
      if (d.type === 'hline' || d.type === 'hray' || d.type === 'cross') {
        const y = this.series.priceToCoordinate(a.price)
        if (y !== null) this.priceViews.push(this.axisView(y, fmt.format(a.price), s.color))
      }
      if (d.type === 'vline' || d.type === 'cross') {
        const x = this.x(a.time)
        if (x !== null) this.timeViews.push(this.axisView(x, timeLabel(a.time), s.color))
      }
    }
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.priceViews
  }

  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.timeViews
  }

  private axisView(coordinate: number, text: string, color: string): ISeriesPrimitiveAxisView {
    return { coordinate: () => coordinate, text: () => text, textColor: () => '#ffffff', backColor: () => color }
  }

  // --- public API ------------------------------------------------------------------

  setDrawings(drawings: Drawing[]): void {
    this.drawings = drawings
    this.selected = null
    this.emitSelection()
    this.creating = null
    this.cancelDrag()
    this.requestUpdate()
  }

  /** Another chart edited the same symbol's drawings: show them, keeping this chart's selection. */
  syncDrawings(drawings: Drawing[]): void {
    this.drawings = drawings
    const drag = this.drag
    if (drag && !drawings.some((d) => d.id === drag.id)) this.cancelDrag()
    if (this.selected && !drawings.some((d) => d.id === this.selected)) this.select(null)
    else this.emitSelection()
    this.requestUpdate()
  }

  getDrawings(): Drawing[] {
    return this.drawings
  }

  getTool(): Tool {
    return this.tool
  }

  setTool(tool: Tool): void {
    this.tool = tool
    this.creating = null
    if (tool !== 'cursor') {
      this.focus()
      this.select(null)
      if (drawingPrefs.get().hidden) drawingPrefs.set({ hidden: false })
    } else if (!this.drag) {
      this.stopDragListeners()
    }
    this.requestUpdate()
    this.onToolChange(tool)
  }

  setColors(colors: DrawingColors): void {
    this.colors = colors
    this.requestUpdate()
  }

  /** Restyle or edit the selected drawing (e.g. from the style bar). */
  updateSelected(patch: Partial<Drawing>): void {
    if (!this.selected) return
    this.drawings = this.drawings.map((d) => (d.id === this.selected ? { ...d, ...patch } : d))
    this.commit()
  }

  /** Copy the selected drawing a little down and to the right, and select the copy. */
  cloneSelected(): void {
    const d = this.drawings.find((x) => x.id === this.selected)
    if (!d) return
    const points = d.points.map((p) => {
      const x = this.x(p.time)
      const y = this.series.priceToCoordinate(p.price)
      const moved = x !== null && y !== null ? this.pointAt(x + 20, y + 20) : null
      return moved ? { time: d.type === 'hline' ? p.time : moved.time, price: moved.price } : p
    })
    const copy: Drawing = { ...d, id: newId(), points, pane: this.pane, locked: undefined }
    this.drawings = [...this.drawings, copy]
    this.select(copy.id)
    this.commit()
  }

  deleteSelected(): void {
    if (!this.selected) return
    this.drawings = this.drawings.filter((d) => d.id !== this.selected)
    this.select(null)
    this.commit()
  }

  clear(): void {
    this.drawings = []
    this.select(null)
    this.commit()
  }

  /** Redraw (e.g. after bars were loaded, which changes the time → x mapping). */
  refresh(): void {
    this.requestUpdate()
  }

  // --- coordinates -------------------------------------------------------------------

  private x(time: number): number | null {
    const logical = timeToLogical(this.getTimes(), this.getTfSeconds(), time)
    return logical === null ? null : this.chart.timeScale().logicalToCoordinate(logical as Logical)
  }

  private project(d: Drawing): Px[] | null {
    const out: Px[] = []
    for (const pt of d.points) {
      const y = this.series.priceToCoordinate(pt.price)
      const x = d.type === 'hline' ? 0 : this.x(pt.time)
      if (x === null || y === null) return null
      out.push({ x, y })
    }
    return out
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private logicalAt(x: number): number | null {
    return this.chart.timeScale().coordinateToLogical(x)
  }

  /** The chart point under (x, y); with the magnet on, snapped to the nearest bar's OHLC. */
  private pointAt(x: number, y: number, e?: PointerEvent): Point | null {
    let logical: number | null = this.logicalAt(x)
    const raw = this.series.coordinateToPrice(y)
    if (logical === null || raw === null) return null
    let price: number = raw
    const magnet = this.magnet(e)
    const bars = this.getBars()
    if (magnet !== 'off' && bars.length) {
      const i = Math.round(logical)
      const bar = bars[i]
      if (bar) {
        const snapped = snapToBar(bar, y, (p) => this.series.priceToCoordinate(p), magnet)
        if (snapped !== null) {
          price = snapped
          logical = i
        }
      }
    }
    const time = logicalToTime(this.getTimes(), this.getTfSeconds(), logical)
    return time === null ? null : { time, price }
  }

  /** The magnet mode in effect; holding Ctrl/⌘ flips it on or off. */
  private magnet(e?: PointerEvent): 'off' | 'weak' | 'strong' {
    const mode = drawingPrefs.get().magnet
    if (!e || !(e.ctrlKey || e.metaKey)) return mode
    return mode === 'off' ? 'strong' : 'off'
  }

  private hitAt(x: number, y: number): { d: Drawing; hit: Hit } | null {
    if (drawingPrefs.get().hidden) return null
    // Selected first, then topmost (last drawn).
    const order = [...this.drawings].reverse().sort((a, b) => Number(b.id === this.selected) - Number(a.id === this.selected))
    for (const d of order) {
      const p = this.project(d)
      const hit = p && hitTest(d, p, x, y, this.textBoxes.get(d.id))
      if (hit) return { d, hit }
    }
    return null
  }

  private isLocked(d: Drawing): boolean {
    return !!d.locked || drawingPrefs.get().locked
  }

  // --- painting -----------------------------------------------------------------------

  private draw(target: CanvasRenderingTarget2D): void {
    if (drawingPrefs.get().hidden) return
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const items = this.creating ? [...this.drawings, this.creating.drawing] : this.drawings
      for (const d of items) {
        const p = this.project(d)
        if (!p) continue
        const selected = d.id === this.selected || d === this.creating?.drawing
        ctx.save()
        this.paint(ctx, d, p, styleOf(d, this.colors.accent), mediaSize.width, mediaSize.height, selected)
        ctx.restore()
        if (selected) this.paintHandles(ctx, d, p, styleOf(d, this.colors.accent).color)
      }
    })
  }

  private paint(ctx: CanvasRenderingContext2D, d: Drawing, p: Px[], s: ResolvedStyle, W: number, H: number, selected: boolean): void {
    const [a, b, c] = p as [Px, Px, Px]
    ctx.strokeStyle = s.color
    ctx.fillStyle = alpha(s.color, s.fill)
    ctx.lineWidth = s.width + (selected ? 0.5 : 0)
    ctx.lineCap = s.dash === 'dotted' ? 'round' : 'butt'
    ctx.setLineDash(s.dash === 'dashed' ? [6, 4] : s.dash === 'dotted' ? [0.5, 3 + s.width] : [])
    const line = (from: Px, to: Px) => {
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }
    const poly = (pts: Px[]) => {
      ctx.beginPath()
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)))
      ctx.closePath()
    }
    const fmt = (price: number) => this.series.priceFormatter().format(price)

    switch (d.type) {
      case 'hline':
        return line({ x: 0, y: a.y }, { x: W, y: a.y })
      case 'hray':
        return line(a, { x: W, y: a.y })
      case 'vline':
        return line({ x: a.x, y: 0 }, { x: a.x, y: H })
      case 'cross':
        line({ x: 0, y: a.y }, { x: W, y: a.y })
        return line({ x: a.x, y: 0 }, { x: a.x, y: H })
      case 'trend': {
        const [from, to] = extendSegment(a, b, s.extendLeft, s.extendRight)
        line(from, to)
        if (s.showLabel) {
          const dp = d.points[1]!.price - d.points[0]!.price
          this.label(ctx, `${dp >= 0 ? '+' : ''}${fmt(dp)} (${(dp / this.getPip()).toFixed(1)} pips)`, b.x, b.y - 6, s.color, 'center', 'bottom')
        }
        return
      }
      case 'arrow': {
        line(a, b)
        const angle = Math.atan2(b.y - a.y, b.x - a.x)
        const size = 7 + s.width * 2
        ctx.setLineDash([])
        ctx.fillStyle = s.color
        poly([
          b,
          { x: b.x - size * Math.cos(angle - 0.45), y: b.y - size * Math.sin(angle - 0.45) },
          { x: b.x - size * Math.cos(angle + 0.45), y: b.y - size * Math.sin(angle + 0.45) },
        ])
        return ctx.fill()
      }
      case 'channel': {
        const { base, parallel } = channelLines(p)
        const b1 = extendSegment(base[0], base[1], s.extendLeft, s.extendRight)
        const p1 = extendSegment(parallel[0], parallel[1], s.extendLeft, s.extendRight)
        poly([b1[0], b1[1], p1[1], p1[0]])
        ctx.fill()
        line(...b1)
        line(...p1)
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        return line({ x: (b1[0].x + p1[0].x) / 2, y: (b1[0].y + p1[0].y) / 2 }, { x: (b1[1].x + p1[1].x) / 2, y: (b1[1].y + p1[1].y) / 2 })
      }
      case 'fib': {
        const [l, r] = spanX(a.x, b.x, s.extendLeft, s.extendRight)
        const levels = [...s.levels].sort((x, y) => x - y)
        levels.forEach((lvl, i) => {
          const y = fibValue(a.y, b.y, lvl)
          const next = levels[i + 1]
          if (next !== undefined && s.fill > 0) {
            ctx.fillStyle = alpha(s.color, i % 2 ? s.fill : s.fill * 2)
            const y2 = fibValue(a.y, b.y, next)
            ctx.fillRect(l, Math.min(y, y2), r - l, Math.abs(y2 - y))
          }
          line({ x: l, y }, { x: r, y })
          if (s.showLabel) {
            const price = fibValue(d.points[0]!.price, d.points[1]!.price, lvl)
            ctx.font = `11px ${FONT}`
            ctx.fillStyle = s.color
            ctx.textBaseline = 'bottom'
            ctx.textAlign = 'left'
            ctx.fillText(`${lvl} (${fmt(price)})`, Math.max(l, 0) + 4, y - 2)
          }
        })
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        return line(a, b)
      }
      case 'rect': {
        const [l, r] = spanX(a.x, b.x, s.extendLeft, s.extendRight)
        const t = Math.min(a.y, b.y)
        const h = Math.abs(b.y - a.y)
        ctx.fillRect(l, t, r - l, h)
        return ctx.strokeRect(l, t, r - l, h)
      }
      case 'ellipse':
        ctx.beginPath()
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
        ctx.fill()
        return ctx.stroke()
      case 'triangle':
        poly([a, b, c])
        ctx.fill()
        return ctx.stroke()
      case 'text': {
        const lines = (s.text || ' ').split('\n')
        const lh = Math.round(s.fontSize * 1.3)
        ctx.font = `${s.fontSize}px ${FONT}`
        ctx.textBaseline = 'top'
        ctx.textAlign = 'left'
        ctx.fillStyle = s.color
        let w = 0
        lines.forEach((t, i) => {
          ctx.fillText(t, a.x, a.y + i * lh)
          w = Math.max(w, ctx.measureText(t).width)
        })
        const box: Box = [a.x - 2, a.y - 2, a.x + w + 2, a.y + lines.length * lh + 2]
        this.textBoxes.set(d.id, box)
        if (selected) {
          ctx.setLineDash([3, 3])
          ctx.lineWidth = 1
          ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1])
        }
        return
      }
      case 'range': {
        const l = Math.min(a.x, b.x)
        const t = Math.min(a.y, b.y)
        ctx.fillRect(l, t, Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        ctx.setLineDash([])
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        this.arrowLine(ctx, { x: mx, y: a.y }, { x: mx, y: b.y }, s.color)
        this.arrowLine(ctx, { x: a.x, y: my }, { x: b.x, y: my }, s.color)
        if (s.showLabel) {
          const [p0, p1] = d.points as [Point, Point]
          const dp = p1.price - p0.price
          const bars = Math.round((timeToLogical(this.getTimes(), this.getTfSeconds(), p1.time) ?? 0) - (timeToLogical(this.getTimes(), this.getTfSeconds(), p0.time) ?? 0))
          const text = `${dp >= 0 ? '+' : ''}${fmt(dp)} (${((dp / p0.price) * 100).toFixed(2)}%)  ${(dp / this.getPip()).toFixed(1)} pips\n${bars} bars, ${duration(p1.time - p0.time)}`
          const below = b.y >= a.y
          this.label(ctx, text, mx, below ? Math.max(a.y, b.y) + 6 : Math.min(a.y, b.y) - 6, s.color, 'center', below ? 'top' : 'bottom')
        }
        return
      }
      case 'long':
      case 'short': {
        const l = Math.min(a.x, b.x)
        const w = Math.abs(b.x - a.x)
        ctx.setLineDash([])
        ctx.fillStyle = alpha(this.colors.up, s.fill)
        ctx.fillRect(l, Math.min(a.y, c.y), w, Math.abs(c.y - a.y))
        ctx.fillStyle = alpha(this.colors.down, s.fill)
        ctx.fillRect(l, Math.min(a.y, b.y), w, Math.abs(b.y - a.y))
        line({ x: l, y: a.y }, { x: l + w, y: a.y })
        if (s.showLabel) {
          const [entry, stop, target] = d.points as [Point, Point, Point]
          const risk = Math.abs(entry.price - stop.price)
          const reward = Math.abs(target.price - entry.price)
          const pips = (v: number) => (v / this.getPip()).toFixed(1)
          const rr = risk ? (reward / risk).toFixed(2) : '—'
          const mx = l + w / 2
          const tUp = c.y < a.y
          this.label(ctx, `Target ${fmt(target.price)}  ${pips(reward)} pips`, mx, tUp ? c.y - 4 : c.y + 4, this.colors.up, 'center', tUp ? 'bottom' : 'top')
          this.label(ctx, `Stop ${fmt(stop.price)}  ${pips(risk)} pips`, mx, tUp ? b.y + 4 : b.y - 4, this.colors.down, 'center', tUp ? 'top' : 'bottom')
          this.label(ctx, `${d.type === 'long' ? 'Long' : 'Short'} ${fmt(entry.price)} · R:R ${rr}`, mx, a.y, s.color, 'center', 'middle')
        }
        return
      }
    }
  }

  private arrowLine(ctx: CanvasRenderingContext2D, from: Px, to: Px, color: string): void {
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    const len = Math.hypot(to.x - from.x, to.y - from.y)
    if (len < 12) return
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(to.x, to.y)
    ctx.lineTo(to.x - 7 * Math.cos(angle - 0.5), to.y - 7 * Math.sin(angle - 0.5))
    ctx.lineTo(to.x - 7 * Math.cos(angle + 0.5), to.y - 7 * Math.sin(angle + 0.5))
    ctx.closePath()
    ctx.fill()
  }

  /** A filled label box with white text (multi-line with \n). */
  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, align: 'left' | 'center', valign: 'top' | 'bottom' | 'middle'): void {
    const lines = text.split('\n')
    ctx.save()
    ctx.setLineDash([])
    ctx.font = `11px ${FONT}`
    const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 12
    const h = lines.length * 15 + 6
    const left = align === 'center' ? x - w / 2 : x
    const top = valign === 'top' ? y : valign === 'bottom' ? y - h : y - h / 2
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.roundRect(left, top, w, h, 3)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    lines.forEach((t, i) => ctx.fillText(t, left + w / 2, top + 4 + i * 15))
    ctx.restore()
  }

  private paintHandles(ctx: CanvasRenderingContext2D, d: Drawing, p: Px[], color: string): void {
    if (d === this.creating?.drawing) return
    ctx.setLineDash([])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = color
    ctx.fillStyle = this.isLocked(d) ? color : '#ffffff'
    for (const h of handlesOf(d.type, p)) {
      ctx.beginPath()
      ctx.arc(h.x, h.y, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  // --- interaction --------------------------------------------------------------------------

  /** Take keyboard shortcuts and drop any selection on the other charts. */
  private focus(): void {
    const prev = DrawingLayer.focused
    if (prev === this) return
    DrawingLayer.focused = this
    prev?.select(null)
  }

  private select(id: string | null): void {
    if (id) this.focus()
    if (this.selected === id) return
    this.selected = id
    this.emitSelection()
    this.requestUpdate()
  }

  private emitSelection(): void {
    this.onSelect(this.drawings.find((d) => d.id === this.selected) ?? null)
  }

  private commit(): void {
    this.requestUpdate()
    this.emitSelection()
    this.onChange(this.drawings)
  }

  private setCursor(cursor: string | null): void {
    if (cursor) {
      this.el.style.cursor = cursor
      this.cursorSet = true
    } else if (this.cursorSet) {
      this.el.style.cursor = ''
      this.cursorSet = false
    }
  }

  private onHover = (e: PointerEvent): void => {
    if (this.drag || this.creating) return
    if (this.tool !== 'cursor') return this.setCursor('crosshair')
    const { x, y } = this.local(e)
    const h = this.hitAt(x, y)
    this.setCursor(h ? (this.isLocked(h.d) ? 'default' : h.hit.part === 'handle' ? 'pointer' : 'move') : null)
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.defaultPrevented || this.drag) return
    this.focus()
    const { x, y } = this.local(e)

    if (this.tool !== 'cursor') {
      const pt = this.pointAt(x, y, e)
      if (!pt) return
      e.preventDefault()
      e.stopPropagation()
      const c = this.creating
      if (c) {
        // Click-by-click: fix the next point.
        c.drawing.points[c.placed] = pt
        c.placed++
        if (c.placed >= PLACED_POINTS[c.drawing.type]) this.finishCreate()
        return
      }
      this.startCreate(pt, x, y)
      return
    }

    const h = this.hitAt(x, y)
    if (!h) {
      this.select(null) // let the chart pan as usual
      return
    }
    e.preventDefault()
    e.stopPropagation()
    this.select(h.d.id)
    if (this.isLocked(h.d)) return
    const logical = this.logicalAt(x)
    const price = this.series.coordinateToPrice(y)
    if (logical === null || price === null) return
    this.drag = { mode: 'edit', id: h.d.id, hit: h.hit, original: h.d, startLogical: logical, startPrice: price, moved: false }
    this.startDragListeners()
  }

  private startCreate(pt: Point, x: number, y: number): void {
    if (this.tool === 'cursor') return
    const def = TOOLS[this.tool]
    const type: DrawingType = def.type
    const drawing: Drawing = { id: newId(), type, points: [], pane: this.pane, ...initialStyle(def.id) }
    if (type === 'long' || type === 'short') {
      // One click: stop 40 px against the trade, target at 2R, 25 bars wide.
      const dir = type === 'long' ? 1 : -1
      const stop = this.series.coordinateToPrice(y + 40 * dir)
      const target = this.series.coordinateToPrice(y - 80 * dir)
      const logical = timeToLogical(this.getTimes(), this.getTfSeconds(), pt.time)
      const end = logical === null ? null : logicalToTime(this.getTimes(), this.getTfSeconds(), logical + 25)
      if (stop === null || target === null || end === null) return
      drawing.points = [pt, { time: end, price: stop }, { time: end, price: target }]
      this.creating = { drawing, placed: 1, press: null }
      return this.finishCreate()
    }
    drawing.points = Array.from({ length: POINT_COUNT[type] }, () => ({ ...pt }))
    this.creating = { drawing, placed: 1, press: { x, y } }
    if (PLACED_POINTS[type] === 1) return this.finishCreate()
    this.startDragListeners()
    this.requestUpdate()
  }

  private finishCreate(): void {
    const d = this.creating?.drawing
    this.creating = null
    this.stopDragListeners()
    if (!d) return
    this.drawings = [...this.drawings, d]
    this.select(d.id)
    this.commit()
    this.onCreate(d)
    if (!drawingPrefs.get().keepDrawing || d.type === 'text') this.setTool('cursor')
  }

  /** Shift keeps a two-point line level with its first point. */
  private constrain(pt: Point, e: PointerEvent, type: DrawingType, anchor: Point | undefined): Point {
    if (!e.shiftKey || !anchor || !['trend', 'arrow', 'fib', 'range', 'channel'].includes(type)) return pt
    return { ...pt, price: anchor.price }
  }

  private onMove = (e: PointerEvent): void => {
    const { x, y } = this.local(e)
    const c = this.creating
    if (c) {
      e.preventDefault()
      e.stopPropagation()
      const pt = this.pointAt(x, y, e)
      if (pt) {
        const next = this.constrain(pt, e, c.drawing.type, c.drawing.points[c.placed - 1])
        for (let i = c.placed; i < c.drawing.points.length; i++) c.drawing.points[i] = { ...next }
        c.drawing = { ...c.drawing }
        this.requestUpdate()
      }
      return
    }

    const drag = this.drag
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    let next: Drawing | null = null
    if (drag.hit.part === 'handle') {
      const pt = this.pointAt(x, y, e)
      const hit = drag.hit
      const other = drag.original.points[hit.time === 1 ? 0 : 1]
      if (pt) next = dragHandle(drag.original, hit, hit.time !== null && hit.time < 2 ? this.constrain(pt, e, drag.original.type, other) : pt)
    } else {
      const logical = this.logicalAt(x)
      const price = this.series.coordinateToPrice(y)
      if (logical !== null && price !== null) {
        const dl = logical - drag.startLogical
        const times = this.getTimes()
        const tf = this.getTfSeconds()
        const shift = (t: number) => logicalToTime(times, tf, (timeToLogical(times, tf, t) ?? 0) + dl) ?? t
        next = moveDrawing(drag.original, price - drag.startPrice, drag.original.type === 'hline' ? (t) => t : shift)
      }
    }
    if (next) {
      drag.moved = true
      this.drawings = this.drawings.map((d) => (d.id === drag.id ? next! : d))
      this.commit() // live, so other charts of the symbol follow the drag
    }
  }

  private onUp = (e: PointerEvent): void => {
    const c = this.creating
    if (c) {
      if (!c.press) return
      e.preventDefault()
      e.stopPropagation()
      const { x, y } = this.local(e)
      const dragged = Math.hypot(x - c.press.x, y - c.press.y) >= MIN_DRAG_PX
      c.press = null
      if (dragged) {
        // Press–drag–release placed the next point where the button came up.
        c.placed++
        if (c.placed >= PLACED_POINTS[c.drawing.type]) this.finishCreate()
      }
      return
    }

    const drag = this.drag
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    this.stopDragListeners()
    this.drag = null
    if (drag.moved) this.commit()
  }

  private cancelDrag(): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    this.stopDragListeners()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (DrawingLayer.focused !== this) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    if (document.querySelector('[role="dialog"]')) return
    if (e.key === 'Escape') {
      const d = this.drag
      if (d) {
        this.drawings = this.drawings.map((x) => (x.id === d.id ? d.original : x))
        this.cancelDrag()
        if (d.moved) this.onChange(this.drawings)
      }
      this.creating = null
      if (this.tool !== 'cursor') this.setTool('cursor')
      this.select(null)
      this.requestUpdate()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault()
      this.deleteSelected()
    } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
      // Alt+letter picks a tool (e.code, since Alt changes e.key on macOS).
      const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : ''
      const tool = Object.values(TOOLS).find((x) => x.key === letter)
      if (tool) {
        e.preventDefault()
        this.setTool(tool.id)
      }
    }
  }

  private startDragListeners(): void {
    window.addEventListener('pointermove', this.onMove, true)
    window.addEventListener('pointerup', this.onUp, true)
  }

  private stopDragListeners(): void {
    window.removeEventListener('pointermove', this.onMove, true)
    window.removeEventListener('pointerup', this.onUp, true)
  }
}
