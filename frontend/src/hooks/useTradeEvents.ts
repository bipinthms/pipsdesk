import { useEffect, useRef } from 'react'
import { useStream } from '../api/stream'
import { toast } from '../components/Toasts'
import { expectedRemovals } from '../lib/actions'
import { signedMoney } from '../lib/format'

/**
 * Toasts for things that happen server-side without a click in this UI:
 * pending orders filling, and positions closed by SL/TP or the broker.
 */
export function useTradeEvents(): void {
  const positions = useStream((s) => s.positions)
  const orders = useStream((s) => s.orders)
  const connected = useStream((s) => s.state === 'open' && s.status?.connected === true)
  const prev = useRef<{ positions: typeof positions; orders: typeof orders } | null>(null)

  useEffect(() => {
    if (!connected) {
      prev.current = null // don't diff across a reconnect
      return
    }
    const before = prev.current
    prev.current = { positions, orders }
    if (!before) return

    const posNow = new Set(positions.map((p) => p.ticket))
    const ordNow = new Set(orders.map((o) => o.ticket))

    for (const o of before.orders) {
      if (ordNow.has(o.ticket)) continue
      if (expectedRemovals.delete(o.ticket)) continue
      if (posNow.has(o.ticket)) toast('success', `Pending order #${o.ticket} filled: ${o.type.replace('_', ' ')} ${o.volume} ${o.symbol}`)
      else toast('warn', `Pending order #${o.ticket} ${o.symbol} was removed by the server`)
    }
    for (const p of before.positions) {
      if (posNow.has(p.ticket)) continue
      if (expectedRemovals.delete(p.ticket)) continue
      // Best guess from the last price we saw: whichever level it was nearest to.
      const dSl = p.sl ? Math.abs(p.price_current - p.sl) : Infinity
      const dTp = p.tp ? Math.abs(p.price_current - p.tp) : Infinity
      const hit = dSl === Infinity && dTp === Infinity ? 'the server' : dSl <= dTp ? 'stop loss' : 'take profit'
      toast(p.profit >= 0 ? 'success' : 'warn', `Position #${p.ticket} ${p.symbol} closed by ${hit} (≈ ${signedMoney(p.profit)})`)
    }
  }, [positions, orders, connected])
}
