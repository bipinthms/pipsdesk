import type { Candle } from '../api/types'

/**
 * Merge streamed bars (last closed + forming, oldest first) into a series.
 * Returns the bars that must be pushed to the chart via `series.update()`, in
 * order. Bars older than the series' last bar are ignored: the chart can only
 * update its last bar or append a new one.
 */
export function mergeLive(bars: Candle[], incoming: Candle[]): Candle[] {
  const applied: Candle[] = []
  for (const c of incoming) {
    const last = bars[bars.length - 1]
    if (!last || c.time < last.time) continue
    if (c.time === last.time) {
      if (sameBar(last, c)) continue
      bars[bars.length - 1] = c
    } else {
      bars.push(c)
    }
    applied.push(c)
  }
  return applied
}

/** Prepend older history, dropping any overlap. Returns how many bars were added. */
export function prependOlder(bars: Candle[], older: Candle[]): number {
  const first = bars[0]
  const fresh = first ? older.filter((c) => c.time < first.time) : older
  bars.unshift(...fresh)
  return fresh.length
}

function sameBar(a: Candle, b: Candle): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume
}
