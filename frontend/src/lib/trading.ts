import type { OrderType, Side, SymbolInfo } from '../api/types'

type Spec = Pick<
  SymbolInfo,
  'digits' | 'point' | 'tick_size' | 'tick_value' | 'volume_min' | 'volume_max' | 'volume_step' | 'currency_base' | 'contract_size'
>

const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD'])

/**
 * What a "pip" means for this symbol:
 * - FX with 5/3 digits: 10 points (0.0001 / 0.01)
 * - metals: 0.1
 * - indices and crypto: 1.0 (an index point / one dollar)
 */
export function pipSize(info: Spec): number {
  if (METALS.has(info.currency_base)) return 0.1
  if (info.digits <= 2 && info.contract_size <= 100) return 1
  if (info.digits === 3 || info.digits === 5) return info.point * 10
  return info.point
}

export function roundPrice(price: number, digits: number): number {
  return Number(price.toFixed(digits))
}

/**
 * Nearest price on the symbol's tick grid (e.g. 0.25 on some indices), as the server
 * would send it. The server rounds a stop loss towards entry; on the grid that's a no-op.
 */
export function snapToTick(price: number, info: Pick<Spec, 'tick_size' | 'point' | 'digits'>): number {
  const tick = info.tick_size || info.point
  return roundPrice(Math.round(price / tick) * tick, info.digits)
}

/** Stop-loss price `pips` away from entry, on the losing side. */
export function slFromPips(side: Side, entry: number, pips: number, info: Spec): number {
  const d = pips * pipSize(info)
  return snapToTick(side === 'buy' ? entry - d : entry + d, info)
}

/** Take-profit price `pips` away from entry, on the winning side. */
export function tpFromPips(side: Side, entry: number, pips: number, info: Spec): number {
  const d = pips * pipSize(info)
  return snapToTick(side === 'buy' ? entry + d : entry - d, info)
}

export function pipsBetween(a: number, b: number, info: Spec): number {
  return Math.abs(a - b) / pipSize(info)
}

/** Money lost per 1.0 lot if price moves from entry to sl (account currency, before commission). */
export function lossPerLot(info: Pick<Spec, 'tick_size' | 'tick_value'>, entry: number, sl: number): number {
  // Prices sit on the tick grid; round away float noise (0.0025000000001) before counting ticks.
  const ticks = Math.round((Math.abs(entry - sl) / info.tick_size) * 1e6) / 1e6
  return ticks * info.tick_value
}

function stepDecimals(step: number): number {
  const s = String(step)
  return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0
}

/** Snap a volume to the symbol's step (nearest) and clamp to its limits. */
export function roundVolume(volume: number, info: Spec): number {
  const steps = Math.round(volume / info.volume_step)
  const v = Number((steps * info.volume_step).toFixed(stepDecimals(info.volume_step)))
  return Math.min(info.volume_max, Math.max(info.volume_min, v))
}

/**
 * Largest volume whose loss at the stop (plus commission) does not exceed `riskAmount`.
 * Rounds *down* to the volume step. Returns 0 if even the minimum volume risks too much.
 */
export function lotsForRisk(riskAmount: number, entry: number, sl: number, info: Spec, commissionPerLot = 0): number {
  const perLot = lossPerLot(info, entry, sl) + commissionPerLot
  if (!(perLot > 0) || !(riskAmount > 0)) return 0
  const steps = Math.floor(riskAmount / perLot / info.volume_step + 1e-9)
  const v = Number((steps * info.volume_step).toFixed(stepDecimals(info.volume_step)))
  if (v < info.volume_min) return 0
  return Math.min(v, info.volume_max)
}

/** Client-side sanity check for a pending order's price. Returns an error message or null. */
export function pendingPriceError(side: Side, type: OrderType, price: number, bid: number, ask: number): string | null {
  if (type === 'market') return null
  if (!(price > 0)) return 'Enter a price.'
  if (type === 'limit' && side === 'buy' && price >= ask) return 'A buy limit must be below the current ask.'
  if (type === 'limit' && side === 'sell' && price <= bid) return 'A sell limit must be above the current bid.'
  if (type === 'stop' && side === 'buy' && price <= ask) return 'A buy stop must be above the current ask.'
  if (type === 'stop' && side === 'sell' && price >= bid) return 'A sell stop must be below the current bid.'
  return null
}

export function orderLabel(side: Side, type: OrderType): string {
  const s = side === 'buy' ? 'Buy' : 'Sell'
  return type === 'market' ? `${s} market` : `${s} ${type}`
}
