import { LineStyle, type AutoscaleInfo, type IPriceLine, type ISeriesApi } from 'lightweight-charts'
import type { LineSpec } from '../lib/tradeLines'

const HIT_PX = 6

export interface LineColors {
  entry: string
  sl: string
  tp: string
}

/**
 * Draws trade lines as series price lines and makes them draggable.
 *
 * lightweight-charts price lines aren't interactive, so this listens for pointer
 * events in the *capture* phase on the chart container. When a press lands within
 * a few pixels of a draggable line, it swallows the event (so the chart doesn't
 * pan) and moves the line until release. `onDrop` then decides what happens; the
 * line is held at the dropped price until the data catches up or `release()` is called.
 */
export class TradeLines {
  private lines = new Map<string, { line: IPriceLine; spec: LineSpec }>()
  /** Lines held at a dragged price while a confirmation or request is in flight. */
  private held = new Map<string, number>()
  private drag: { id: string; start: number; price: number; pointerId: number } | null = null
  private hovering = false
  /** Price range the scale is pinned to while a line is dragged (so it doesn't shift under the cursor). */
  private frozen: AutoscaleInfo | null = null
  private lastScale: AutoscaleInfo | null = null

  onDrop: (spec: LineSpec, price: number) => void = () => {}
  /** Called on every move while dragging (used to update the order panel live). */
  onDrag: (spec: LineSpec, price: number) => void = () => {}
  dragTitle: (spec: LineSpec, price: number) => string = (s) => s.title

  constructor(
    private readonly el: HTMLElement,
    private readonly series: ISeriesApi<'Candlestick'>,
    private colors: LineColors,
    private digits: number,
  ) {
    el.addEventListener('pointerdown', this.onDown, true)
    el.addEventListener('pointermove', this.onHover, true)
    // Fit the price scale to the trade lines too, so a distant SL/TP isn't drawn off-screen.
    series.applyOptions({
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        if (this.frozen) return this.frozen
        return (this.lastScale = this.autoscale(base()))
      },
    })
  }

  private autoscale(info: AutoscaleInfo | null): AutoscaleInfo | null {
    if (!info?.priceRange || this.lines.size === 0) return info
    let { minValue, maxValue } = info.priceRange
    for (const [id, { spec }] of this.lines) {
      const p = this.held.get(id) ?? spec.price
      minValue = Math.min(minValue, p)
      maxValue = Math.max(maxValue, p)
    }
    return { ...info, priceRange: { minValue, maxValue } }
  }

  destroy(): void {
    this.el.removeEventListener('pointerdown', this.onDown, true)
    this.el.removeEventListener('pointermove', this.onHover, true)
    this.stopListening()
    for (const { line } of this.lines.values()) this.series.removePriceLine(line)
    this.lines.clear()
    this.series.applyOptions({ autoscaleInfoProvider: undefined })
  }

  setColors(colors: LineColors): void {
    this.colors = colors
    for (const { line, spec } of this.lines.values()) line.applyOptions(this.style(spec))
  }

  setDigits(digits: number): void {
    this.digits = digits
  }

  /** Sync drawn lines with `specs` (create, update, remove). */
  set(specs: LineSpec[]): void {
    const seen = new Set<string>()
    for (const spec of specs) {
      seen.add(spec.id)
      const held = this.held.get(spec.id)
      const existing = this.lines.get(spec.id)
      // Draft lines follow the order panel: any new price from it supersedes the held one
      // (in pips mode the panel's price can differ from the dragged one by rounding).
      const caughtUp =
        held !== undefined &&
        (Math.abs(held - spec.price) < 10 ** -(this.digits + 1) ||
          (spec.source === 'draft' && existing !== undefined && existing.spec.price !== spec.price))
      if (caughtUp) this.held.delete(spec.id)
      const dragging = this.drag?.id === spec.id
      const price = dragging ? this.drag!.price : (this.held.get(spec.id) ?? spec.price)
      const title = dragging || this.held.has(spec.id) ? this.dragTitle(spec, price) : spec.title
      if (existing) {
        existing.spec = spec
        existing.line.applyOptions({ price, title })
      } else {
        const line = this.series.createPriceLine({ ...this.style(spec), price, title })
        this.lines.set(spec.id, { line, spec })
      }
    }
    for (const [id, { line }] of this.lines) {
      if (seen.has(id)) continue
      if (this.drag?.id === id) this.cancelDrag()
      this.series.removePriceLine(line)
      this.lines.delete(id)
      this.held.delete(id)
    }
  }

  /** Snap a held line back to its real price (after cancel or failure). */
  release(id: string): void {
    this.held.delete(id)
    const entry = this.lines.get(id)
    if (entry) entry.line.applyOptions({ price: entry.spec.price, title: entry.spec.title })
  }

  // --- styling -----------------------------------------------------------------

  private style(spec: LineSpec) {
    const base = spec.role === 'entry' ? this.colors.entry : spec.role === 'sl' ? this.colors.sl : this.colors.tp
    const color = spec.source === 'draft' ? base + 'aa' : base
    return {
      color,
      lineWidth: (spec.source === 'position' && spec.role === 'entry' ? 2 : 1) as 1 | 2,
      lineStyle: spec.source === 'position' ? LineStyle.Solid : spec.source === 'order' ? LineStyle.Dashed : LineStyle.Dotted,
      axisLabelVisible: true,
      lineVisible: true,
    }
  }

  // --- hit testing and dragging ---------------------------------------------------

  private y(e: PointerEvent): number {
    return e.clientY - this.el.getBoundingClientRect().top
  }

  private hit(y: number): string | null {
    let best: string | null = null
    let bestDist = HIT_PX
    for (const [id, { spec }] of this.lines) {
      if (!spec.drag) continue
      const coord = this.series.priceToCoordinate(this.held.get(id) ?? spec.price)
      if (coord === null) continue
      // Real orders/positions win over the order-panel draft when lines overlap.
      const d = Math.abs(coord - y) + (spec.source === 'draft' ? 0.5 : 0)
      if (d <= bestDist) {
        best = id
        bestDist = d
      }
    }
    return best
  }

  private setCursor(target: EventTarget | null, on: boolean): void {
    if (on === this.hovering) return
    this.hovering = on
    const cursor = on ? 'ns-resize' : ''
    this.el.style.cursor = cursor
    if (target instanceof HTMLElement) target.style.cursor = cursor
  }

  private onHover = (e: PointerEvent): void => {
    if (this.drag) return
    this.setCursor(e.target, this.hit(this.y(e)) !== null)
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.drag) return
    const id = this.hit(this.y(e))
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    const start = this.held.get(id) ?? this.lines.get(id)!.spec.price
    this.drag = { id, start, price: start, pointerId: e.pointerId }
    this.frozen = this.lastScale
    window.addEventListener('pointermove', this.onMove, true)
    window.addEventListener('pointerup', this.onUp, true)
    window.addEventListener('keydown', this.onKey, true)
  }

  private onMove = (e: PointerEvent): void => {
    const d = this.drag
    if (!d || e.pointerId !== d.pointerId) return
    e.preventDefault()
    e.stopPropagation()
    const raw = this.series.coordinateToPrice(this.y(e))
    if (raw === null) return
    d.price = Number(raw.toFixed(this.digits))
    const entry = this.lines.get(d.id)
    if (!entry) return
    entry.line.applyOptions({ price: d.price, title: this.dragTitle(entry.spec, d.price) })
    this.onDrag(entry.spec, d.price)
  }

  private onUp = (e: PointerEvent): void => {
    const d = this.drag
    if (!d || e.pointerId !== d.pointerId) return
    e.preventDefault()
    e.stopPropagation()
    this.stopListening()
    this.drag = null
    const entry = this.lines.get(d.id)
    if (!entry) return
    // Unmoved, or already applied live (draft lines): nothing to hold.
    if (d.price === d.start || (entry.spec.source === 'draft' && d.price === entry.spec.price)) {
      this.release(d.id)
      if (d.price === d.start) return
    } else {
      this.held.set(d.id, d.price)
    }
    this.onDrop(entry.spec, d.price)
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.drag) return
    const { id, start, price } = this.drag
    this.cancelDrag()
    // Undo any live edits made while dragging.
    const entry = this.lines.get(id)
    if (entry && price !== start) this.onDrag(entry.spec, start)
  }

  private cancelDrag(): void {
    const d = this.drag
    this.stopListening()
    this.drag = null
    if (d) this.release(d.id)
  }

  private stopListening(): void {
    this.frozen = null
    window.removeEventListener('pointermove', this.onMove, true)
    window.removeEventListener('pointerup', this.onUp, true)
    window.removeEventListener('keydown', this.onKey, true)
  }
}
