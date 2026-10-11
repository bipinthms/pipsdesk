import type { PendingOrder, Position, Side, SymbolInfo } from '../api/types'
import { signedMoney } from './format'
import { lossPerLot } from './trading'

/** What a dragged line should change when dropped. */
export type DragTarget =
  | { kind: 'position'; ticket: number; field: 'sl' | 'tp' | 'entry' }
  | { kind: 'order'; ticket: number; field: 'price' | 'sl' | 'tp' }
  | { kind: 'draft'; field: 'entry' | 'sl' | 'tp' }

export type LineRole = 'entry' | 'sl' | 'tp'

export interface LineSpec {
  id: string
  role: LineRole
  side: Side
  /** 'position' = solid, 'order' = dashed, 'draft' = dotted and dimmed. */
  source: 'position' | 'order' | 'draft'
  price: number
  title: string
  drag: DragTarget | null
}

/** The order the trader is composing in the order panel. */
export interface Draft {
  symbol: string
  side: Side
  type: 'market' | 'limit' | 'stop'
  entry: number | null
  sl: number | null
  tp: number | null
  volume: number | null
}

type Spec = Pick<SymbolInfo, 'tick_size' | 'tick_value'>

/** Signed P/L in account currency if price goes from `entry` to `level`. */
export function pnlAt(info: Spec, side: Side, volume: number, entry: number, level: number): number {
  const amount = lossPerLot(info, entry, level) * volume
  const gains = side === 'buy' ? level > entry : level < entry
  return gains ? amount : -amount
}

/** Which order field a price on the given side of entry represents (loss side → SL, profit side → TP). */
export function stopFieldFor(side: Side, entry: number, price: number): 'sl' | 'tp' {
  return (side === 'buy') === price < entry ? 'sl' : 'tp'
}

const pendingLabel: Record<PendingOrder['type'], string> = {
  buy_limit: 'BUY LIMIT', sell_limit: 'SELL LIMIT', buy_stop: 'BUY STOP', sell_stop: 'SELL STOP',
}

export function levelTitle(role: 'sl' | 'tp', info: Spec | undefined, side: Side, volume: number | null, entry: number, level: number): string {
  const label = role.toUpperCase()
  if (!info || !volume) return label
  return `${label} ${signedMoney(pnlAt(info, side, volume, entry, level))}`
}

/** All trade lines for one symbol's chart. Pure: the chart diffs these against what it has drawn. */
export function buildLineSpecs(
  symbol: string,
  positions: Position[],
  orders: PendingOrder[],
  draft: Draft | null,
  info: Spec | undefined,
): LineSpec[] {
  const specs: LineSpec[] = []

  for (const p of positions) {
    if (p.symbol !== symbol) continue
    specs.push({
      id: `pos:${p.ticket}:entry`, role: 'entry', side: p.side, source: 'position', price: p.price_open,
      title: `${p.side.toUpperCase()} ${p.volume} ${signedMoney(p.profit + p.swap)}`,
      // Dragging the entry line out creates (or moves) the SL or TP, depending on direction.
      drag: { kind: 'position', ticket: p.ticket, field: 'entry' },
    })
    for (const role of ['sl', 'tp'] as const) {
      const level = p[role]
      if (level == null) continue
      specs.push({
        id: `pos:${p.ticket}:${role}`, role, side: p.side, source: 'position', price: level,
        title: levelTitle(role, info, p.side, p.volume, p.price_open, level),
        drag: { kind: 'position', ticket: p.ticket, field: role },
      })
    }
  }

  for (const o of orders) {
    if (o.symbol !== symbol) continue
    const side: Side = o.type.startsWith('buy') ? 'buy' : 'sell'
    specs.push({
      id: `ord:${o.ticket}:entry`, role: 'entry', side, source: 'order', price: o.price_open,
      title: `${pendingLabel[o.type]} ${o.volume}`,
      drag: { kind: 'order', ticket: o.ticket, field: 'price' },
    })
    for (const role of ['sl', 'tp'] as const) {
      const level = o[role]
      if (level == null) continue
      specs.push({
        id: `ord:${o.ticket}:${role}`, role, side, source: 'order', price: level,
        title: levelTitle(role, info, side, o.volume, o.price_open, level),
        drag: { kind: 'order', ticket: o.ticket, field: role },
      })
    }
  }

  if (draft && draft.symbol === symbol && draft.entry !== null) {
    const { side, entry, volume } = draft
    const vol = volume ? ` ${volume}` : ''
    specs.push({
      id: 'draft:entry', role: 'entry', side, source: 'draft', price: entry,
      title: draft.type === 'market' ? `NEW ${side.toUpperCase()}${vol}` : `NEW ${side.toUpperCase()} ${draft.type.toUpperCase()}${vol}`,
      // Pending: drag moves the price. Market: the price is the quote, so dragging out sets the SL or TP.
      drag: { kind: 'draft', field: 'entry' },
    })
    for (const role of ['sl', 'tp'] as const) {
      const level = draft[role]
      if (level === null) continue
      specs.push({
        id: `draft:${role}`, role, side, source: 'draft', price: level,
        title: levelTitle(role, info, side, volume, entry, level),
        drag: { kind: 'draft', field: role },
      })
    }
  }

  return specs
}
