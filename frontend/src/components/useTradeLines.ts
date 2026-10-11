import { useEffect, useRef, type RefObject } from 'react'
import { api } from '../api/client'
import { useStream } from '../api/stream'
import type { SymbolInfo } from '../api/types'
import type { Theme } from '../hooks/useTheme'
import { trade } from '../lib/actions'
import { editDraft, useDraft } from '../lib/draft'
import { price as fmtPrice, signedMoney } from '../lib/format'
import { buildLineSpecs, levelTitle, pnlAt, stopFieldFor, type LineSpec } from '../lib/tradeLines'
import { pipsBetween } from '../lib/trading'
import { useConfirm } from './Confirm'
import type { LineColors, TradeLines } from './TradeLines'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function lineColors(): LineColors {
  return { entry: cssVar('--accent'), sl: cssVar('--down'), tp: cssVar('--up') }
}

/** Keep the chart's trade lines in sync with positions, orders and the order draft, and handle drops. */
export function useTradeLines(
  ctl: RefObject<TradeLines | null>,
  symbol: string,
  info: SymbolInfo | undefined,
  theme: Theme,
): void {
  const positions = useStream((s) => s.positions)
  const orders = useStream((s) => s.orders)
  const draft = useDraft()
  const { confirm } = useConfirm()

  const data = useRef({ positions, orders, draft, info, confirm })
  data.current = { positions, orders, draft, info, confirm }

  useEffect(() => {
    ctl.current?.set(buildLineSpecs(symbol, positions, orders, draft, info))
  }, [ctl, symbol, positions, orders, draft, info])

  useEffect(() => ctl.current?.setDigits(info?.digits ?? 5), [ctl, info])
  useEffect(() => ctl.current?.setColors(lineColors()), [ctl, theme])

  useEffect(() => {
    const c = ctl.current
    if (!c) return

    /** Side, volume and entry of whatever owns the line. */
    const owner = (spec: LineSpec) => {
      const { positions, orders, draft } = data.current
      const t = spec.drag
      if (!t) return null
      if (t.kind === 'position') {
        const p = positions.find((x) => x.ticket === t.ticket)
        return p ? { side: p.side, volume: p.volume, entry: p.price_open } : null
      }
      if (t.kind === 'order') {
        const o = orders.find((x) => x.ticket === t.ticket)
        return o ? { side: spec.side, volume: o.volume, entry: o.price_open } : null
      }
      return draft?.entry != null ? { side: draft.side, volume: draft.volume, entry: draft.entry } : null
    }

    c.dragTitle = (spec, price) => {
      const o = owner(spec)
      const t = spec.drag
      if (!o || !t) return spec.title
      if (spec.role === 'sl' || spec.role === 'tp') {
        return levelTitle(spec.role, data.current.info, o.side, o.volume, o.entry, price)
      }
      // Dragging out of a position or market draft's entry sets its SL or TP.
      if (t.kind === 'position' || (t.kind === 'draft' && data.current.draft?.type === 'market')) {
        const field = stopFieldFor(o.side, o.entry, price)
        return `→ ${levelTitle(field, data.current.info, o.side, o.volume, o.entry, price)}`
      }
      return spec.title
    }

    // Draft lines update the order panel live while being dragged.
    c.onDrag = (spec, price) => {
      const t = spec.drag
      if (t?.kind !== 'draft') return
      if (t.field === 'entry' && data.current.draft?.type === 'market') return // applied on drop
      editDraft({ field: t.field, price })
    }

    c.onDrop = (spec, price) => {
      const t = spec.drag
      const { positions, orders, info, confirm } = data.current
      if (!t) return c.release(spec.id)
      const digits = info?.digits ?? 5
      const fmt = (v: number | null | undefined) => (v == null ? 'None' : fmtPrice(v, digits))

      if (t.kind === 'draft') {
        const draft = data.current.draft
        if (t.field === 'entry' && draft?.type === 'market') {
          // The market entry line is the live quote and never moves: dropping it sets the SL or TP.
          c.release(spec.id)
          if (draft.entry != null && price !== draft.entry) {
            editDraft({ field: stopFieldFor(draft.side, draft.entry, price), price })
          }
          return
        }
        editDraft({ field: t.field, price })
        return
      }

      if (t.kind === 'position') {
        const p = positions.find((x) => x.ticket === t.ticket)
        if (!p) return c.release(spec.id)
        const field = t.field === 'entry' ? stopFieldFor(p.side, p.price_open, price) : t.field
        // The entry line itself never moves; dragging it only creates/moves the SL or TP.
        if (t.field === 'entry') c.release(spec.id)
        const sl = field === 'sl' ? price : p.sl
        const tp = field === 'tp' ? price : p.tp
        const name = field === 'sl' ? 'stop loss' : 'take profit'
        void confirm({
          always: true, // drags are easy to do by accident: confirm even in one-click mode
          tone: 'neutral',
          title: `${p[field] == null ? 'Set' : 'Move'} ${name} · ${p.symbol} #${p.ticket}`,
          rows: [
            ['From', fmt(p[field])],
            ['To', `${fmt(price)}${info ? ` (${pipsBetween(p.price_open, price, info).toFixed(1)} pips)` : ''}`],
            ['P/L at this level', info ? signedMoney(pnlAt(info, p.side, p.volume, p.price_open, price)) : '—'],
          ],
          confirmLabel: 'Send modification',
          run: async () => {
            await trade(
              () => api.modifyPosition(p.ticket, { sl, tp }),
              () => `#${p.ticket} ${field.toUpperCase()} → ${fmt(price)}`,
            )
            setTimeout(() => c.release(spec.id), 2000) // in case the stream never echoes the exact price
          },
          onCancel: () => c.release(spec.id),
        })
        return
      }

      const o = orders.find((x) => x.ticket === t.ticket)
      if (!o) return c.release(spec.id)
      const next = {
        price: t.field === 'price' ? price : o.price_open,
        sl: t.field === 'sl' ? price : o.sl,
        tp: t.field === 'tp' ? price : o.tp,
      }
      const label = t.field === 'price' ? 'order price' : t.field === 'sl' ? 'stop loss' : 'take profit'
      void confirm({
        always: true,
        tone: 'neutral',
        title: `Move ${label} · ${o.symbol} #${o.ticket}`,
        rows: [
          ['From', fmt(t.field === 'price' ? o.price_open : o[t.field])],
          ['To', fmt(price)],
        ],
        confirmLabel: 'Send modification',
        run: async () => {
          await trade(() => api.modifyOrder(o.ticket, next), () => `Order #${o.ticket} ${label} → ${fmt(price)}`)
          setTimeout(() => c.release(spec.id), 2000)
        },
        onCancel: () => c.release(spec.id),
      })
    }
  }, [ctl])
}
