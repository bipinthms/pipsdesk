import { describe, expect, it } from 'vitest'
import {
  channelLines,
  distToSegment,
  dragHandle,
  extendSegment,
  fibValue,
  fromLegacy,
  hitTest,
  logicalToTime,
  moveDrawing,
  POINT_COUNT,
  snapToBar,
  styleOf,
  timeToLogical,
  type Drawing,
  type DrawingType,
  type Px,
} from './drawings'

// M1 bars with a gap (e.g. a session break between 180 and 600)
const TIMES = [0, 60, 120, 180, 600, 660]

describe('time ↔ logical', () => {
  it('maps bar times to their index', () => {
    TIMES.forEach((t, i) => expect(timeToLogical(TIMES, 60, t)).toBe(i))
  })
  it('interpolates inside gaps', () => {
    expect(timeToLogical(TIMES, 60, 30)).toBe(0.5)
    expect(timeToLogical(TIMES, 60, 390)).toBe(3.5) // halfway through the gap
  })
  it('extrapolates with the bar length beyond both ends', () => {
    expect(timeToLogical(TIMES, 60, 780)).toBe(7)
    expect(timeToLogical(TIMES, 60, -120)).toBe(-2)
  })
  it('round-trips', () => {
    for (const t of [0, 30, 390, 660, 780, -120]) {
      expect(logicalToTime(TIMES, 60, timeToLogical(TIMES, 60, t)!)).toBe(t)
    }
  })
  it('a time from a finer timeframe lands between coarser bars', () => {
    const H1 = [0, 3600, 7200]
    expect(timeToLogical(H1, 3600, 5400)).toBe(1.5)
  })
  it('returns null with no bars', () => {
    expect(timeToLogical([], 60, 0)).toBeNull()
    expect(logicalToTime([], 60, 0)).toBeNull()
  })
})

const pt = (time: number, price: number) => ({ time, price })
const make = (type: DrawingType, extra: Partial<Drawing> = {}): Drawing => ({
  id: type,
  type,
  points: Array.from({ length: POINT_COUNT[type] }, (_, i) => pt(i, i)),
  ...extra,
})
const px = (...xy: number[]): Px[] => Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[i * 2]!, y: xy[i * 2 + 1]! }))

describe('hitTest', () => {
  it('horizontal line and ray', () => {
    expect(hitTest(make('hline'), px(0, 100), 50, 104)).toEqual({ part: 'body' })
    expect(hitTest(make('hline'), px(0, 100), 50, 107)).toBeNull()
    expect(hitTest(make('hray'), px(40, 100), 30, 100)).toBeNull() // left of its start
    expect(hitTest(make('hray'), px(40, 100), 300, 101)).toEqual({ part: 'body' })
  })

  it('vertical and cross lines', () => {
    expect(hitTest(make('vline'), px(50, 0), 52, 300)).toEqual({ part: 'body' })
    expect(hitTest(make('cross'), px(50, 50), 200, 52)).toEqual({ part: 'body' })
    expect(hitTest(make('cross'), px(50, 50), 200, 200)).toBeNull()
  })

  const trend = px(0, 0, 100, 100)
  it('trend line endpoints take priority over the body', () => {
    expect(hitTest(make('trend'), trend, 3, 2)).toEqual({ part: 'handle', time: 0, price: 0 })
    expect(hitTest(make('trend'), trend, 98, 101)).toEqual({ part: 'handle', time: 1, price: 1 })
    expect(hitTest(make('trend'), trend, 50, 53)).toEqual({ part: 'body' })
    expect(hitTest(make('trend'), trend, 50, 60)).toBeNull()
    expect(hitTest(make('trend'), trend, 120, 120)).toBeNull() // beyond the segment
  })

  it('extended trend lines hit beyond their points', () => {
    expect(hitTest(make('trend', { extendRight: true }), trend, 300, 300)).toEqual({ part: 'body' })
    expect(hitTest(make('trend', { extendRight: true }), trend, -50, -50)).toBeNull()
    expect(hitTest(make('trend', { extendLeft: true }), trend, -50, -50)).toEqual({ part: 'body' })
  })

  const rect = px(10, 10, 110, 60)
  it('rectangle corners map to the right point components', () => {
    expect(hitTest(make('rect'), rect, 10, 60)).toEqual({ part: 'handle', time: 0, price: 1 })
    expect(hitTest(make('rect'), rect, 110, 10)).toEqual({ part: 'handle', time: 1, price: 0 })
    expect(hitTest(make('rect'), rect, 60, 35)).toEqual({ part: 'body' })
    expect(hitTest(make('rect'), rect, 200, 35)).toBeNull()
    expect(hitTest(make('rect', { extendRight: true }), rect, 200, 35)).toEqual({ part: 'body' })
  })

  it('ellipse hits inside its bounds only', () => {
    expect(hitTest(make('ellipse'), rect, 60, 35)).toEqual({ part: 'body' })
    expect(hitTest(make('ellipse'), rect, 18, 13)).toBeNull() // corner outside the curve (no handle there either)
  })

  it('triangle and channel hit inside', () => {
    expect(hitTest(make('triangle'), px(0, 100, 100, 100, 50, 0), 50, 60)).toEqual({ part: 'body' })
    expect(hitTest(make('triangle'), px(0, 100, 100, 100, 50, 0), 10, 10)).toBeNull()
    // baseline 0,100 → 100,100, parallel line through (50, 50)
    expect(hitTest(make('channel'), px(0, 100, 100, 100, 50, 50), 30, 75)).toEqual({ part: 'body' })
    expect(hitTest(make('channel'), px(0, 100, 100, 100, 50, 50), 30, 30)).toBeNull()
  })

  it('position handles: entry, stop, target and right edge', () => {
    const p = px(0, 50, 100, 80, 100, 10) // entry 50, stop 80, target 10, right edge at x=100
    expect(hitTest(make('long'), p, 0, 80)).toEqual({ part: 'handle', time: null, price: 1 })
    expect(hitTest(make('long'), p, 0, 10)).toEqual({ part: 'handle', time: null, price: 2 })
    expect(hitTest(make('long'), p, 100, 50)).toEqual({ part: 'handle', time: 1, price: null })
    expect(hitTest(make('long'), p, 50, 30)).toEqual({ part: 'body' })
  })

  it('text uses its measured box', () => {
    expect(hitTest(make('text'), px(10, 10), 20, 15, [8, 8, 60, 30])).toEqual({ part: 'body' })
    expect(hitTest(make('text'), px(10, 10), 20, 15)).toBeNull()
  })

  it('distToSegment handles a zero-length segment', () => {
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBe(5)
  })
})

describe('geometry helpers', () => {
  it('extendSegment keeps direction', () => {
    const [a, b] = extendSegment({ x: 0, y: 0 }, { x: 10, y: 5 }, false, true)
    expect(a).toEqual({ x: 0, y: 0 })
    expect(b.y / b.x).toBeCloseTo(0.5)
    expect(b.x).toBeGreaterThan(1000)
  })

  it('channelLines offsets the baseline through the third point', () => {
    const { parallel } = channelLines(px(0, 0, 100, 100, 50, 20))
    expect(parallel).toEqual([{ x: 0, y: -30 }, { x: 100, y: 70 }])
  })

  it('fib level 0 is the end, 1 the start', () => {
    expect(fibValue(1.1, 1.0, 0)).toBe(1.0)
    expect(fibValue(1.1, 1.0, 1)).toBe(1.1)
    expect(fibValue(1.1, 1.0, 0.5)).toBeCloseTo(1.05)
  })

  it('styleOf fills in type defaults and the accent colour', () => {
    expect(styleOf(make('rect'), '#123456')).toMatchObject({ color: '#123456', fill: 0.15, width: 1 })
    expect(styleOf(make('rect', { fill: 0.4, color: '#ff0000' }), '#123456')).toMatchObject({ color: '#ff0000', fill: 0.4 })
  })
})

describe('magnet', () => {
  const bar = { open: 1.1, high: 1.3, low: 1.0, close: 1.2 }
  const toY = (p: number) => (2 - p) * 100 // 1.3 → 70, 1.0 → 100
  it('strong snaps to the nearest OHLC', () => {
    expect(snapToBar(bar, 0, toY, 'strong')).toBe(1.3)
    expect(snapToBar(bar, 92, toY, 'strong')).toBe(1.1)
  })
  it('weak snaps only when close', () => {
    expect(snapToBar(bar, 72, toY, 'weak')).toBe(1.3)
    expect(snapToBar(bar, 0, toY, 'weak')).toBeNull()
  })
})

describe('edits', () => {
  const rect: Drawing = { id: 'r', type: 'rect', points: [pt(0, 1), pt(600, 2)] }

  it('moveDrawing shifts every point', () => {
    expect(moveDrawing(rect, 0.5, (t) => t + 60)).toEqual({ id: 'r', type: 'rect', points: [pt(60, 1.5), pt(660, 2.5)] })
  })

  it('dragHandle moves one corner and leaves the opposite one', () => {
    const r = dragHandle(rect, { part: 'handle', time: 0, price: 1 }, pt(120, 3))
    expect(r.points).toEqual([pt(120, 1), pt(600, 3)])
    expect(rect.points[0]!.time).toBe(0) // original untouched
  })

  it("a position's target follows its right edge", () => {
    const pos: Drawing = { id: 'p', type: 'long', points: [pt(0, 1), pt(600, 0.9), pt(600, 1.2)] }
    const r = dragHandle(pos, { part: 'handle', time: 1, price: null }, pt(900, 5))
    expect(r.points).toEqual([pt(0, 1), pt(900, 0.9), pt(900, 1.2)])
  })
})

describe('fromLegacy', () => {
  it('converts drawings saved before points[]', () => {
    expect(fromLegacy({ id: 'h', type: 'hline', price: 1.1 })).toEqual({ id: 'h', type: 'hline', points: [pt(0, 1.1)] })
    expect(fromLegacy({ id: 't', type: 'trend', p1: pt(1, 1), p2: pt(2, 2), color: '#ff8800' })).toEqual({
      id: 't', type: 'trend', points: [pt(1, 1), pt(2, 2)], color: '#ff8800',
    })
  })
})
