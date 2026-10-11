import { describe, expect, it } from 'vitest'
import type { PendingOrder, Position } from '../api/types'
import { buildLineSpecs, pnlAt, stopFieldFor, type Draft } from './tradeLines'

const INFO = { tick_size: 0.00001, tick_value: 1 } // EURUSD-like: 1 lot, 1 pip = $10

const pos = (over: Partial<Position> = {}): Position => ({
  ticket: 1, symbol: 'EURUSD', side: 'buy', volume: 0.5, price_open: 1.1, price_current: 1.101,
  sl: 1.095, tp: 1.11, profit: 50, swap: -1, time: 0, comment: '', ...over,
})

const order = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  ticket: 2, symbol: 'EURUSD', type: 'sell_limit', volume: 0.2, price_open: 1.105, price_current: 1.1,
  sl: 1.108, tp: null, time_setup: 0, comment: '', ...over,
})

const draft = (over: Partial<Draft> = {}): Draft => ({
  symbol: 'EURUSD', side: 'buy', type: 'market', entry: 1.1, sl: null, tp: null, volume: 1, ...over,
})

describe('pnlAt', () => {
  it('is negative at the stop and positive at the target for both sides', () => {
    expect(pnlAt(INFO, 'buy', 1, 1.1, 1.095)).toBeCloseTo(-500)
    expect(pnlAt(INFO, 'buy', 1, 1.1, 1.11)).toBeCloseTo(1000)
    expect(pnlAt(INFO, 'sell', 0.5, 1.1, 1.105)).toBeCloseTo(-250)
    expect(pnlAt(INFO, 'sell', 0.5, 1.1, 1.09)).toBeCloseTo(500)
  })
})

describe('stopFieldFor', () => {
  it('maps the loss side to SL and the profit side to TP', () => {
    expect(stopFieldFor('buy', 1.1, 1.09)).toBe('sl')
    expect(stopFieldFor('buy', 1.1, 1.11)).toBe('tp')
    expect(stopFieldFor('sell', 1.1, 1.11)).toBe('sl')
    expect(stopFieldFor('sell', 1.1, 1.09)).toBe('tp')
  })
})

describe('buildLineSpecs', () => {
  it('draws entry, SL and TP for a position with P/L labels', () => {
    const specs = buildLineSpecs('EURUSD', [pos()], [], null, INFO)
    expect(specs.map((s) => s.id)).toEqual(['pos:1:entry', 'pos:1:sl', 'pos:1:tp'])
    expect(specs[0]!.title).toBe('BUY 0.5 +$49.00') // profit + swap
    expect(specs[1]!.title).toBe('SL -$250.00')
    expect(specs[2]!.title).toBe('TP +$500.00')
    expect(specs[1]!.drag).toEqual({ kind: 'position', ticket: 1, field: 'sl' })
  })

  it('skips missing levels and other symbols', () => {
    const specs = buildLineSpecs('EURUSD', [pos({ sl: null, tp: null }), pos({ ticket: 9, symbol: 'GBPUSD' })], [], null, INFO)
    expect(specs.map((s) => s.id)).toEqual(['pos:1:entry'])
  })

  it('draws pending orders with a draggable price', () => {
    const specs = buildLineSpecs('EURUSD', [], [order()], null, INFO)
    expect(specs.map((s) => [s.id, s.title])).toEqual([
      ['ord:2:entry', 'SELL LIMIT 0.2'],
      ['ord:2:sl', 'SL -$60.00'],
    ])
    expect(specs[0]!.side).toBe('sell')
    expect(specs[0]!.drag).toEqual({ kind: 'order', ticket: 2, field: 'price' })
  })

  it('draft: entry line is always drawn, even with no levels', () => {
    const specs = buildLineSpecs('EURUSD', [], [], draft(), INFO)
    expect(specs.map((s) => [s.id, s.title, s.drag])).toEqual([
      ['draft:entry', 'NEW BUY 1', { kind: 'draft', field: 'entry' }],
    ])
  })

  it('draft: SL/TP lines appear once set and are draggable', () => {
    const specs = buildLineSpecs('EURUSD', [], [], draft({ sl: 1.095 }), INFO)
    expect(specs.map((s) => [s.id, s.drag])).toEqual([
      ['draft:entry', { kind: 'draft', field: 'entry' }],
      ['draft:sl', { kind: 'draft', field: 'sl' }],
    ])
  })

  it('draft: pending entry is labelled with the order type', () => {
    const specs = buildLineSpecs('EURUSD', [], [], draft({ type: 'limit', entry: 1.09, volume: null }), INFO)
    expect(specs[0]).toMatchObject({ id: 'draft:entry', title: 'NEW BUY LIMIT', price: 1.09 })
  })

  it('draft on another symbol is ignored', () => {
    expect(buildLineSpecs('GBPUSD', [], [], draft({ sl: 1.09 }), INFO)).toEqual([])
  })

  it('labels without money when volume is unknown', () => {
    const specs = buildLineSpecs('EURUSD', [], [], draft({ sl: 1.095, volume: null }), INFO)
    expect(specs[1]!.title).toBe('SL')
  })
})
