// Chart drawings: data model and pure geometry (time ↔ bar index mapping, hit testing, edits).

export interface Point {
  time: number // MT5 server time, epoch seconds
  price: number
}

export const DRAWING_TYPES = [
  'hline', 'hray', 'vline', 'cross', 'trend', 'arrow', 'channel', 'fib',
  'rect', 'ellipse', 'triangle', 'text', 'range', 'long', 'short',
] as const
export type DrawingType = (typeof DRAWING_TYPES)[number]

export type Dash = 'solid' | 'dashed' | 'dotted'

/** Per-drawing settings. Anything left out falls back to `STYLE_DEFAULTS` when drawn. */
export interface DrawingStyle {
  color?: string // #rrggbb; unset follows the theme accent
  width?: number // 1–4 px
  dash?: Dash
  fill?: number // fill opacity 0–1 (shapes, channels, zones)
  extendLeft?: boolean
  extendRight?: boolean
  text?: string
  fontSize?: number
  showLabel?: boolean // price/time axis labels, Fib level labels, range and position stats
  levels?: number[] // Fib levels
}

export interface Drawing extends DrawingStyle {
  id: string
  type: DrawingType
  /**
   * hline/hray/vline/cross/text: [anchor]. Two-point tools: [start, end].
   * channel: [a, b, offset point]; triangle: three corners.
   * long/short: [entry, stop (its time is the right edge), target].
   */
  points: Point[]
  locked?: boolean
  /** Chart pane it was drawn on; with drawing sync off, only that pane shows it. */
  pane?: string
}

export const POINT_COUNT: Record<DrawingType, number> = {
  hline: 1, hray: 1, vline: 1, cross: 1, text: 1,
  trend: 2, arrow: 2, fib: 2, rect: 2, ellipse: 2, range: 2,
  channel: 3, triangle: 3, long: 3, short: 3,
}

/** Points the user places; the rest are filled in (a position is placed with one click). */
export const PLACED_POINTS: Record<DrawingType, number> = { ...POINT_COUNT, long: 1, short: 1 }

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
export const FIB_CHOICES = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236]

/** Which settings each type offers (colour, width and line style apply to all). */
export const CAPS: Record<DrawingType, { fill?: true; extend?: true; text?: true; label?: true; levels?: true }> = {
  hline: { label: true },
  hray: { label: true },
  vline: { label: true },
  cross: { label: true },
  trend: { extend: true, label: true },
  arrow: {},
  channel: { fill: true, extend: true },
  fib: { fill: true, extend: true, label: true, levels: true },
  rect: { fill: true, extend: true },
  ellipse: { fill: true },
  triangle: { fill: true },
  text: { text: true },
  range: { fill: true, label: true },
  long: { fill: true, label: true },
  short: { fill: true, label: true },
}

export const TYPE_NAMES: Record<DrawingType, string> = {
  hline: 'Horizontal line', hray: 'Horizontal ray', vline: 'Vertical line', cross: 'Cross line',
  trend: 'Trend line', arrow: 'Arrow', channel: 'Parallel channel', fib: 'Fib retracement',
  rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', text: 'Text',
  range: 'Price range', long: 'Long position', short: 'Short position',
}

const BASE: Required<Omit<DrawingStyle, 'color'>> = {
  width: 2, dash: 'solid', fill: 0, extendLeft: false, extendRight: false,
  text: '', fontSize: 14, showLabel: false, levels: FIB_LEVELS,
}

export const STYLE_DEFAULTS: Record<DrawingType, DrawingStyle> = {
  hline: { width: 1, showLabel: true },
  hray: { width: 1, showLabel: true },
  vline: { width: 1, showLabel: true },
  cross: { width: 1, showLabel: true },
  trend: {},
  arrow: {},
  channel: { fill: 0.1 },
  fib: { width: 1, fill: 0.06, showLabel: true },
  rect: { width: 1, fill: 0.15 },
  ellipse: { width: 1, fill: 0.15 },
  triangle: { width: 1, fill: 0.15 },
  text: { text: 'Text' },
  range: { width: 1, fill: 0.15, showLabel: true },
  long: { width: 1, fill: 0.2, showLabel: true },
  short: { width: 1, fill: 0.2, showLabel: true },
}

export type ResolvedStyle = Required<Omit<DrawingStyle, 'color'>> & { color: string }

export function styleOf(d: Drawing, accent: string): ResolvedStyle {
  const s = { ...BASE, ...STYLE_DEFAULTS[d.type] }
  for (const k of Object.keys(d) as (keyof DrawingStyle)[]) {
    if (k in BASE && d[k] !== undefined) (s as Record<string, unknown>)[k] = d[k]
  }
  return { ...s, color: d.color ?? accent }
}

/** Settings remembered as a tool's default when a drawing of that type is restyled. */
export const REMEMBERED: (keyof DrawingStyle)[] = ['color', 'width', 'dash', 'fill', 'fontSize', 'showLabel', 'levels']

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

// ---------------------------------------------------------------------------
// Time ↔ logical (fractional bar index)
//
// Drawings store absolute times so they survive timeframe changes. The chart's
// x axis is bar-indexed, so we interpolate between bar times, and extrapolate
// with the timeframe's bar length beyond either end (e.g. a trend line
// projected into the future).
// ---------------------------------------------------------------------------

export function timeToLogical(times: readonly number[], tfSeconds: number, time: number): number | null {
  const n = times.length
  if (n === 0) return null
  const first = times[0]!
  const last = times[n - 1]!
  if (time <= first) return (time - first) / tfSeconds
  if (time >= last) return n - 1 + (time - last) / tfSeconds
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid]! <= time) lo = mid
    else hi = mid
  }
  return lo + (time - times[lo]!) / (times[hi]! - times[lo]!)
}

export function logicalToTime(times: readonly number[], tfSeconds: number, logical: number): number | null {
  const n = times.length
  if (n === 0) return null
  if (logical <= 0) return Math.round(times[0]! + logical * tfSeconds)
  if (logical >= n - 1) return Math.round(times[n - 1]! + (logical - (n - 1)) * tfSeconds)
  const i = Math.floor(logical)
  return Math.round(times[i]! + (logical - i) * (times[i + 1]! - times[i]!))
}

// ---------------------------------------------------------------------------
// Pixel geometry
// ---------------------------------------------------------------------------

export interface Px {
  x: number
  y: number
}

/** [left, top, right, bottom] */
export type Box = [number, number, number, number]

const FAR = 10_000 // px; "to the edge of the pane" for extended lines

/** The segment a→b, optionally extended beyond either end. */
export function extendSegment(a: Px, b: Px, left: boolean, right: boolean): [Px, Px] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (!len) return [a, b]
  const k = FAR / len
  return [left ? { x: a.x - dx * k, y: a.y - dy * k } : a, right ? { x: b.x + dx * k, y: b.y + dy * k } : b]
}

/** A parallel channel: the a→b line and its copy through c. */
export function channelLines([a, b, c]: Px[]): { base: [Px, Px]; parallel: [Px, Px] } {
  const yOnBase = a!.x === b!.x ? a!.y : a!.y + ((b!.y - a!.y) * (c!.x - a!.x)) / (b!.x - a!.x)
  const dy = c!.y - yOnBase
  return { base: [a!, b!], parallel: [{ x: a!.x, y: a!.y + dy }, { x: b!.x, y: b!.y + dy }] }
}

/** Fib level 0 is at the end point, 1 at the start (works for prices and for pixel y). */
export function fibValue(start: number, end: number, level: number): number {
  return end + (start - end) * level
}

/** Horizontal extent of a box-like drawing (rectangle, Fib), with its extend options. */
export function spanX(x1: number, x2: number, left: boolean, right: boolean): [number, number] {
  return [left ? -FAR : Math.min(x1, x2), right ? FAR : Math.max(x1, x2)]
}

// ---------------------------------------------------------------------------
// Hit testing (in pixels)
// ---------------------------------------------------------------------------

/** Which part was grabbed. A handle drives one point's time and/or one point's price. */
export type Hit = { part: 'body' } | { part: 'handle'; time: number | null; price: number | null }

export interface Handle {
  x: number
  y: number
  time: number | null // index of the point whose time this handle drags
  price: number | null // index of the point whose price it drags
}

export const HANDLE_PX = 7
export const LINE_PX = 5

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function nearSegment(x: number, y: number, [a, b]: [Px, Px]): boolean {
  return distToSegment(x, y, a.x, a.y, b.x, b.y) <= LINE_PX
}

function inBox(x: number, y: number, [l, t, r, b]: Box, pad = LINE_PX): boolean {
  return x >= l - pad && x <= r + pad && y >= t - pad && y <= b + pad
}

function boxOf(a: Px, b: Px): Box {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
}

export function inPolygon(x: number, y: number, poly: Px[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Draggable handles, in pixels, for a drawing whose points project to `p`. */
export function handlesOf(type: DrawingType, p: Px[]): Handle[] {
  const [a, b, c] = p
  switch (type) {
    case 'hline':
    case 'vline':
    case 'text':
      return []
    case 'hray':
    case 'cross':
      return [{ ...a!, time: 0, price: 0 }]
    case 'rect':
    case 'ellipse':
      return [
        { ...a!, time: 0, price: 0 },
        { ...b!, time: 1, price: 1 },
        { x: a!.x, y: b!.y, time: 0, price: 1 },
        { x: b!.x, y: a!.y, time: 1, price: 0 },
      ]
    case 'channel':
    case 'triangle':
      return [{ ...a!, time: 0, price: 0 }, { ...b!, time: 1, price: 1 }, { ...c!, time: 2, price: 2 }]
    case 'long':
    case 'short':
      return [
        { ...a!, time: 0, price: 0 }, // entry
        { x: a!.x, y: b!.y, time: null, price: 1 }, // stop
        { x: a!.x, y: c!.y, time: null, price: 2 }, // target
        { x: b!.x, y: a!.y, time: 1, price: null }, // right edge
      ]
    default:
      return [{ ...a!, time: 0, price: 0 }, { ...b!, time: 1, price: 1 }]
  }
}

/**
 * What's under (x, y)? Handles win over the body. `textBox` is the measured
 * extent of a text drawing (from the last paint).
 */
export function hitTest(d: Drawing, p: Px[], x: number, y: number, textBox?: Box): Hit | null {
  for (const h of handlesOf(d.type, p)) {
    if (Math.hypot(x - h.x, y - h.y) <= HANDLE_PX) return { part: 'handle', time: h.time, price: h.price }
  }
  return hitBody(d, p, x, y, textBox) ? { part: 'body' } : null
}

function hitBody(d: Drawing, p: Px[], x: number, y: number, textBox?: Box): boolean {
  const [a, b, c] = p
  const left = !!d.extendLeft
  const right = !!d.extendRight
  switch (d.type) {
    case 'hline':
      return Math.abs(y - a!.y) <= LINE_PX
    case 'hray':
      return Math.abs(y - a!.y) <= LINE_PX && x >= a!.x - LINE_PX
    case 'vline':
      return Math.abs(x - a!.x) <= LINE_PX
    case 'cross':
      return Math.abs(y - a!.y) <= LINE_PX || Math.abs(x - a!.x) <= LINE_PX
    case 'trend':
    case 'arrow':
      return nearSegment(x, y, extendSegment(a!, b!, left, right))
    case 'channel': {
      const { base, parallel } = channelLines(p)
      return (
        nearSegment(x, y, extendSegment(base[0], base[1], left, right)) ||
        nearSegment(x, y, extendSegment(parallel[0], parallel[1], left, right)) ||
        inPolygon(x, y, [base[0], base[1], parallel[1], parallel[0]])
      )
    }
    case 'fib':
    case 'rect': {
      const [l, r] = spanX(a!.x, b!.x, left, right)
      return inBox(x, y, [l, Math.min(a!.y, b!.y), r, Math.max(a!.y, b!.y)])
    }
    case 'range':
      return inBox(x, y, boxOf(a!, b!))
    case 'long':
    case 'short':
      return inBox(x, y, [Math.min(a!.x, b!.x), Math.min(b!.y, c!.y, a!.y), Math.max(a!.x, b!.x), Math.max(b!.y, c!.y, a!.y)])
    case 'ellipse': {
      const rx = Math.abs(b!.x - a!.x) / 2 + LINE_PX
      const ry = Math.abs(b!.y - a!.y) / 2 + LINE_PX
      const cx = (a!.x + b!.x) / 2
      const cy = (a!.y + b!.y) / 2
      return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
    }
    case 'triangle':
      return (
        inPolygon(x, y, p) ||
        nearSegment(x, y, [a!, b!]) || nearSegment(x, y, [b!, c!]) || nearSegment(x, y, [c!, a!])
      )
    case 'text':
      return !!textBox && inBox(x, y, textBox, 2)
  }
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** Keep derived coordinates consistent (a position's stop and target share its right edge). */
function normalize(d: Drawing): Drawing {
  if ((d.type === 'long' || d.type === 'short') && d.points[2]) d.points[2].time = d.points[1]!.time
  return d
}

/** Move a whole drawing by a price delta and a time-shifting function. */
export function moveDrawing(d: Drawing, dPrice: number, shiftTime: (t: number) => number): Drawing {
  return normalize({ ...d, points: d.points.map((p) => ({ time: shiftTime(p.time), price: p.price + dPrice })) })
}

/** Drag a handle to `to`: it moves its point's time and/or price. */
export function dragHandle(d: Drawing, hit: Extract<Hit, { part: 'handle' }>, to: Point): Drawing {
  const points = d.points.map((p) => ({ ...p }))
  if (hit.time !== null) points[hit.time]!.time = to.time
  if (hit.price !== null) points[hit.price]!.price = to.price
  return normalize({ ...d, points })
}

/**
 * Snap a price to the nearest of a bar's open/high/low/close (the drawing magnet).
 * `toY` maps prices to pixels; weak mode only snaps within `radius` px of the pointer.
 */
export function snapToBar(
  bar: { open: number; high: number; low: number; close: number },
  y: number,
  toY: (price: number) => number | null,
  mode: 'weak' | 'strong',
  radius = 30,
): number | null {
  let best: number | null = null
  let bestDist = Infinity
  for (const price of [bar.open, bar.high, bar.low, bar.close]) {
    const py = toY(price)
    if (py === null) continue
    const dist = Math.abs(py - y)
    if (dist < bestDist) {
      best = price
      bestDist = dist
    }
  }
  return mode === 'strong' || bestDist <= radius ? best : null
}

/** Accept drawings saved before points[] existed ({price} or {p1, p2}). */
export function fromLegacy(raw: unknown): Drawing | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown> & Partial<Drawing>
  if (Array.isArray(r.points)) return r as Drawing
  const { price, p1, p2, ...rest } = r as Record<string, unknown>
  const points = typeof price === 'number' ? [{ time: 0, price }] : [p1, p2].filter(Boolean)
  return { ...(rest as unknown as Drawing), points: points as Point[] }
}
