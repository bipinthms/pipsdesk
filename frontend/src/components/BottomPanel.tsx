import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import { useStream } from '../api/stream'
import type { Deal, JournalEntry, JournalStatus, PendingOrder, Position, RiskSettings, SymbolInfo } from '../api/types'
import { expectedRemovals, trade } from '../lib/actions'
import { money, price as fmtPrice, serverTime, signedMoney } from '../lib/format'
import { pipsBetween, roundVolume } from '../lib/trading'
import { useConfirm } from './Confirm'
import { PanelToggle } from './PanelToggle'
import { toast } from './Toasts'

type Tab = 'positions' | 'orders' | 'history' | 'journal'

interface Props {
  symbols: SymbolInfo[]
  /** Risk settings: whether the "no stop loss" override is offered. */
  settings?: RiskSettings
  onSelectSymbol: (s: string) => void
  /** Collapsed: only the tab bar shows; clicking a tab expands it again. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

const th = 'px-2 py-1.5 font-normal text-left'
const td = 'px-2 py-1 whitespace-nowrap'
const btn = 'rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-fg'

function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty: string | false }) {
  return (
    <table className="num w-full text-[12px]">
      <thead className="sticky top-0 z-10 bg-panel text-[11px] text-muted">
        <tr className="border-b border-line">
          {head.map((h) => (
            <th key={h} className={th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {children}
        {empty && (
          <tr>
            <td colSpan={head.length} className="px-2 py-6 text-center font-sans text-muted">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

const pnlClass = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : '')
const sideClass = (s: string | null) => (s === 'buy' ? 'text-up' : s === 'sell' ? 'text-down' : '')

// ---------------------------------------------------------------------------
// Modals with inputs
// ---------------------------------------------------------------------------

function useStopsEditor(bySymbol: Map<string, SymbolInfo>, allowNoSlOverride: boolean) {
  const { confirm } = useConfirm()

  return (target: { kind: 'position'; p: Position } | { kind: 'order'; o: PendingOrder }) => {
    const item = target.kind === 'position' ? target.p : target.o
    const info = bySymbol.get(item.symbol)
    const digits = info?.digits ?? 5
    const ref = target.kind === 'position' ? target.p.price_open : target.o.price_open
    const state = {
      price: fmtPrice(ref, digits),
      sl: item.sl ? fmtPrice(item.sl, digits) : '',
      tp: item.tp ? fmtPrice(item.tp, digits) : '',
      allowNoSl: false,
    }
    const parse = (s: string) => (s.trim() === '' ? null : Number(s))

    const Inputs = () => {
      const [v, setV] = useState(state)
      useEffect(() => void Object.assign(state, v), [v])
      const dist = (s: string) => {
        const n = parse(s)
        return info && n ? `${pipsBetween(parse(v.price) ?? ref, n, info).toFixed(1)} pips` : ''
      }
      const input = (key: 'price' | 'sl' | 'tp', label: string) => (
        <label className="flex flex-col gap-1">
          <span className="flex justify-between text-[11px] text-muted">
            <span>{label}</span>
            {key !== 'price' && <span>{dist(v[key])}</span>}
          </span>
          <input
            className="num rounded border border-line bg-panel-2 px-2 py-1.5 text-right outline-none focus:border-accent"
            inputMode="decimal"
            value={v[key]}
            placeholder={key === 'price' ? '' : 'none'}
            onChange={(e) => setV({ ...v, [key]: e.target.value })}
          />
        </label>
      )
      return (
        <div className="flex flex-col gap-2">
          {target.kind === 'order' && input('price', 'Order price')}
          <div className="grid grid-cols-2 gap-2">
            {input('sl', 'Stop loss')}
            {input('tp', 'Take profit')}
          </div>
          {v.sl.trim() === '' && allowNoSlOverride && (
            <label className="flex items-center gap-1.5 text-[11px] text-warn">
              <input type="checkbox" checked={v.allowNoSl} onChange={(e) => setV({ ...v, allowNoSl: e.target.checked })} />
              Remove the stop loss (override)
            </label>
          )}
        </div>
      )
    }

    void confirm({
      title: `Modify ${target.kind === 'position' ? 'position' : 'order'} #${item.ticket} · ${item.symbol}`,
      tone: 'neutral',
      confirmLabel: 'Send modification',
      rows: [
        ['Current SL', item.sl ? fmtPrice(item.sl, digits) : 'None'],
        ['Current TP', item.tp ? fmtPrice(item.tp, digits) : 'None'],
      ],
      body: <Inputs />,
      run: async () => {
        const sl = parse(state.sl)
        const tp = parse(state.tp)
        if ([sl, tp].some((x) => x !== null && !(x > 0))) throw new Error('Enter valid prices.')
        if (target.kind === 'position') {
          await trade(
            () => api.modifyPosition(item.ticket, { sl, tp, allow_no_sl: state.allowNoSl }),
            () => `Position #${item.ticket} updated`,
          )
        } else {
          const price = parse(state.price)
          if (!price || !(price > 0)) throw new Error('Enter a valid order price.')
          await trade(
            () => api.modifyOrder(item.ticket, { price, sl, tp, allow_no_sl: state.allowNoSl }),
            () => `Order #${item.ticket} updated`,
          )
        }
      },
    })
  }
}

function useCloser(bySymbol: Map<string, SymbolInfo>) {
  const { confirm } = useConfirm()
  return (p: Position) => {
    const info = bySymbol.get(p.symbol)
    const state = { volume: String(p.volume) }
    const Inputs = () => {
      const [v, setV] = useState(state.volume)
      useEffect(() => void (state.volume = v), [v])
      return (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Volume to close (max {p.volume})</span>
          <input
            className="num rounded border border-line bg-panel-2 px-2 py-1.5 text-right outline-none focus:border-accent"
            inputMode="decimal"
            value={v}
            onChange={(e) => setV(e.target.value)}
          />
        </label>
      )
    }
    const run = async () => {
      const vol = Number(state.volume)
      if (!(vol > 0) || vol > p.volume + 1e-9) throw new Error(`Volume must be between ${info?.volume_min ?? 0.01} and ${p.volume}.`)
      const partial = Math.abs(vol - p.volume) > 1e-9
      const volume = partial && info ? roundVolume(vol, info) : undefined
      if (!partial) expectedRemovals.add(p.ticket)
      await trade(
        () => api.closePosition(p.ticket, volume),
        (r) => `Closed ${r.result.volume} ${p.symbol} #${p.ticket} @ ${fmtPrice(r.result.price, info?.digits ?? 5)}`,
      ).catch((e) => {
        expectedRemovals.delete(p.ticket)
        throw e
      })
    }
    void confirm({
      title: `Close ${p.side} ${p.symbol} #${p.ticket}`,
      tone: 'danger',
      confirmLabel: 'Close position',
      rows: [
        ['Open', fmtPrice(p.price_open, info?.digits ?? 5)],
        ['Current', fmtPrice(p.price_current, info?.digits ?? 5)],
        ['P/L', <span className={pnlClass(p.profit)}>{signedMoney(p.profit)}</span>],
      ],
      body: <Inputs />,
      run,
    })
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface TabProps {
  bySymbol: Map<string, SymbolInfo>
  onSelectSymbol: (s: string) => void
  allowNoSlOverride: boolean
}

function PositionsTab({ bySymbol, onSelectSymbol, allowNoSlOverride }: TabProps) {
  const positions = useStream((s) => s.positions)
  const edit = useStopsEditor(bySymbol, allowNoSlOverride)
  const close = useCloser(bySymbol)
  return (
    <Table head={['Symbol', 'Ticket', 'Side', 'Volume', 'Open', 'Current', 'SL', 'TP', 'Swap', 'P/L', 'Opened', '']} empty={positions.length === 0 && 'No open positions'}>
      {positions.map((p) => {
        const d = bySymbol.get(p.symbol)?.digits ?? 5
        return (
          <tr key={p.ticket} className="border-b border-line/60 hover:bg-panel-2">
            <td className={td}>
              <button type="button" className="font-sans font-medium hover:text-accent" onClick={() => onSelectSymbol(p.symbol)}>
                {p.symbol}
              </button>
            </td>
            <td className={`${td} text-muted`}>{p.ticket}</td>
            <td className={`${td} ${sideClass(p.side)}`}>{p.side}</td>
            <td className={td}>{p.volume}</td>
            <td className={td}>{fmtPrice(p.price_open, d)}</td>
            <td className={td}>{fmtPrice(p.price_current, d)}</td>
            <td className={td}>{p.sl ? fmtPrice(p.sl, d) : <span className="text-warn">none</span>}</td>
            <td className={td}>{p.tp ? fmtPrice(p.tp, d) : '—'}</td>
            <td className={td}>{p.swap.toFixed(2)}</td>
            <td className={`${td} ${pnlClass(p.profit)}`}>{signedMoney(p.profit)}</td>
            <td className={`${td} text-muted`}>{serverTime(p.time)}</td>
            <td className={`${td} text-right`}>
              <span className="inline-flex gap-1">
                <button type="button" className={btn} onClick={() => edit({ kind: 'position', p })}>
                  SL/TP
                </button>
                <button type="button" className={`${btn} hover:border-down hover:text-down`} onClick={() => close(p)}>
                  Close
                </button>
              </span>
            </td>
          </tr>
        )
      })}
    </Table>
  )
}

const TYPE_LABEL: Record<PendingOrder['type'], string> = {
  buy_limit: 'buy limit', sell_limit: 'sell limit', buy_stop: 'buy stop', sell_stop: 'sell stop',
}

function OrdersTab({ bySymbol, onSelectSymbol, allowNoSlOverride }: TabProps) {
  const orders = useStream((s) => s.orders)
  const edit = useStopsEditor(bySymbol, allowNoSlOverride)
  const { confirm } = useConfirm()
  const cancel = (o: PendingOrder) =>
    void confirm({
      key: `cancel:${o.ticket}`,
      title: `Cancel ${TYPE_LABEL[o.type]} ${o.symbol} #${o.ticket}`,
      tone: 'danger',
      confirmLabel: 'Cancel order',
      rows: [
        ['Volume', String(o.volume)],
        ['Price', fmtPrice(o.price_open, bySymbol.get(o.symbol)?.digits ?? 5)],
      ],
      run: async () => {
        expectedRemovals.add(o.ticket)
        await trade(() => api.cancelOrder(o.ticket), () => `Order #${o.ticket} cancelled`).catch((e) => {
          expectedRemovals.delete(o.ticket)
          throw e
        })
      },
    })
  return (
    <Table head={['Symbol', 'Ticket', 'Type', 'Volume', 'Price', 'Current', 'SL', 'TP', 'Placed', '']} empty={orders.length === 0 && 'No pending orders'}>
      {orders.map((o) => {
        const d = bySymbol.get(o.symbol)?.digits ?? 5
        return (
          <tr key={o.ticket} className="border-b border-line/60 hover:bg-panel-2">
            <td className={td}>
              <button type="button" className="font-sans font-medium hover:text-accent" onClick={() => onSelectSymbol(o.symbol)}>
                {o.symbol}
              </button>
            </td>
            <td className={`${td} text-muted`}>{o.ticket}</td>
            <td className={`${td} ${sideClass(o.type.split('_')[0]!)}`}>{TYPE_LABEL[o.type]}</td>
            <td className={td}>{o.volume}</td>
            <td className={td}>{fmtPrice(o.price_open, d)}</td>
            <td className={td}>{fmtPrice(o.price_current, d)}</td>
            <td className={td}>{o.sl ? fmtPrice(o.sl, d) : <span className="text-warn">none</span>}</td>
            <td className={td}>{o.tp ? fmtPrice(o.tp, d) : '—'}</td>
            <td className={`${td} text-muted`}>{serverTime(o.time_setup)}</td>
            <td className={`${td} text-right`}>
              <span className="inline-flex gap-1">
                <button type="button" className={btn} onClick={() => edit({ kind: 'order', o })}>
                  Edit
                </button>
                <button type="button" className={`${btn} hover:border-down hover:text-down`} onClick={() => cancel(o)}>
                  Cancel
                </button>
              </span>
            </td>
          </tr>
        )
      })}
    </Table>
  )
}

/** Refetch when `deps` change (e.g. a position closes) and every `intervalMs`. */
function useRefreshing<T>(fetcher: () => Promise<T>, deps: unknown[], intervalMs: number): [T | undefined, string | undefined] {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    const run = () =>
      fetcher().then(
        (d) => !cancelled && (setData(d), setError(undefined)),
        (e: Error) => !cancelled && setError(e.message),
      )
    run()
    const t = setInterval(run, intervalMs)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, deps)
  return [data, error]
}

function HistoryTab({ bySymbol }: { bySymbol: Map<string, SymbolInfo> }) {
  const [days, setDays] = useState(7)
  const nPositions = useStream((s) => s.positions.length)
  const [deals, error] = useRefreshing<Deal[]>(() => api.history(days), [days, nPositions], 15_000)
  const rows = (deals ?? []).filter((d) => d.entry !== 'other' || d.profit !== 0)
  const realised = rows.reduce((sum, d) => sum + d.profit + d.commission + d.swap, 0)
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-2 py-1 text-[11px] text-muted">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-line bg-panel-2 px-1 py-0.5">
          {[1, 7, 30, 90].map((d) => (
            <option key={d} value={d}>
              Last {d} day{d > 1 ? 's' : ''}
            </option>
          ))}
        </select>
        <span>
          Net: <span className={`num ${pnlClass(realised)}`}>{signedMoney(realised)}</span>
        </span>
        {error && <span className="text-down">{error}</span>}
      </div>
      <Table head={['Time', 'Symbol', 'Deal', 'Position', 'Side', 'Entry', 'Volume', 'Price', 'Profit', 'Comm.', 'Swap', 'Reason']} empty={deals !== undefined && rows.length === 0 && 'No deals in this period'}>
        {rows.map((d) => (
          <tr key={d.ticket} className="border-b border-line/60">
            <td className={`${td} text-muted`}>{serverTime(d.time)}</td>
            <td className={`${td} font-sans`}>{d.symbol || 'balance'}</td>
            <td className={`${td} text-muted`}>{d.ticket}</td>
            <td className={`${td} text-muted`}>{d.position_id || ''}</td>
            <td className={`${td} ${sideClass(d.side)}`}>{d.side ?? ''}</td>
            <td className={td}>{d.entry}</td>
            <td className={td}>{d.volume || ''}</td>
            <td className={td}>{d.price ? fmtPrice(d.price, bySymbol.get(d.symbol)?.digits ?? 5) : ''}</td>
            <td className={`${td} ${pnlClass(d.profit)}`}>{d.profit ? money(d.profit) : ''}</td>
            <td className={td}>{d.commission ? money(d.commission) : ''}</td>
            <td className={td}>{d.swap ? money(d.swap) : ''}</td>
            <td className={`${td} text-muted`}>{d.reason}</td>
          </tr>
        ))}
      </Table>
    </div>
  )
}

const STATUS_STYLE: Record<JournalStatus, string> = {
  accepted: 'text-up border-up/40',
  blocked: 'text-warn border-warn/40',
  rejected: 'text-down border-down/40',
  error: 'text-down border-down/40',
  unknown: 'text-warn border-warn',
  info: 'text-muted border-line',
}

/** Click to add or edit a note on a journal entry; Enter or blur saves, Esc cancels. */
function NoteCell({ entry }: { entry: JournalEntry }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(entry.note)
  const [saved, setSaved] = useState(entry.note)
  useEffect(() => {
    if (!editing) {
      setValue(entry.note)
      setSaved(entry.note)
    }
  }, [entry.note, editing])

  const commit = async () => {
    setEditing(false)
    if (value === saved) return
    try {
      await api.setJournalNote(entry.id, value)
      setSaved(value)
    } catch (e) {
      setValue(saved)
      toast('error', `Couldn't save note: ${(e as Error).message}`)
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        maxLength={2000}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') {
            setValue(saved)
            setEditing(false)
          }
        }}
        className="w-full rounded border border-accent bg-panel-2 px-1 py-0.5 font-sans text-[12px] outline-none"
        aria-label={`Note for journal entry ${entry.id}`}
      />
    )
  }
  return (
    <button type="button" onClick={() => setEditing(true)} title="Click to edit"
      className={`w-full text-left font-sans whitespace-normal ${saved ? 'text-fg' : 'text-muted/60 hover:text-muted'}`}>
      {saved || '+ note'}
    </button>
  )
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function exportJournal(status: JournalStatus | '') {
  try {
    const rows = await api.journal(1000, status || undefined)
    const cols: (keyof JournalEntry)[] = ['id', 'time_utc', 'action', 'status', 'symbol', 'side', 'volume', 'price', 'sl', 'tp', 'ticket', 'retcode', 'risk_amount', 'reason', 'note']
    const lines = [
      ['time_iso', ...cols].join(','),
      ...rows.map((r) => [new Date(r.time_utc * 1000).toISOString(), ...cols.map((c) => r[c])].map(csvCell).join(',')),
    ]
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `pipdesk-journal-${new Date().toLocaleDateString('en-CA')}.csv` // local YYYY-MM-DD
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    toast('error', `Export failed: ${(e as Error).message}`)
  }
}

function JournalTab() {
  const [status, setStatus] = useState<JournalStatus | ''>('')
  const nPositions = useStream((s) => s.positions.length)
  const nOrders = useStream((s) => s.orders.length)
  const [entries, error] = useRefreshing<JournalEntry[]>(() => api.journal(300, status || undefined), [status, nPositions, nOrders], 5_000)
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-2 py-1 text-[11px] text-muted">
        <select value={status} onChange={(e) => setStatus(e.target.value as JournalStatus | '')} className="rounded border border-line bg-panel-2 px-1 py-0.5">
          <option value="">All attempts</option>
          <option value="accepted">Accepted</option>
          <option value="blocked">Blocked by risk</option>
          <option value="rejected">Rejected by broker</option>
          <option value="error">Errors</option>
          <option value="unknown">Unclear outcome</option>
          <option value="info">Info</option>
        </select>
        <button type="button" className={btn} onClick={() => void exportJournal(status)}>
          Export CSV
        </button>
        {error && <span className="text-down">{error}</span>}
      </div>
      <Table head={['Time (local)', 'Action', 'Status', 'Symbol', 'Side', 'Volume', 'Price', 'SL', 'TP', 'Ticket', 'Risk', 'Reason', 'Note']} empty={entries !== undefined && entries.length === 0 && 'Nothing journaled yet'}>
        {(entries ?? []).map((e) => (
          <tr key={e.id} className="border-b border-line/60 align-top">
            <td className={`${td} text-muted`}>{new Date(e.time_utc * 1000).toLocaleString()}</td>
            <td className={`${td} font-sans`}>{e.action.replace('_', ' ')}</td>
            <td className={td}>
              <span className={`rounded border px-1 font-sans text-[10px] uppercase ${STATUS_STYLE[e.status]}`}>{e.status}</span>
            </td>
            <td className={`${td} font-sans`}>{e.symbol ?? ''}</td>
            <td className={`${td} ${sideClass(e.side)}`}>{e.side ?? ''}</td>
            <td className={td}>{e.volume ?? ''}</td>
            <td className={td}>{e.price ?? ''}</td>
            <td className={td}>{e.sl ?? ''}</td>
            <td className={td}>{e.tp ?? ''}</td>
            <td className={`${td} text-muted`}>{e.ticket ?? ''}</td>
            <td className={td}>{e.risk_amount != null ? money(e.risk_amount) : ''}</td>
            <td className="min-w-64 px-2 py-1 font-sans whitespace-normal text-muted">{e.reason}</td>
            <td className="min-w-48 px-2 py-1">
              <NoteCell entry={e} />
            </td>
          </tr>
        ))}
      </Table>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function BottomPanel({ symbols, settings, onSelectSymbol, collapsed = false, onCollapsedChange }: Props) {
  const allowNoSlOverride = !!settings?.allow_no_sl_override
  const [tab, setTab] = useState<Tab>('positions')
  const positions = useStream((s) => s.positions)
  const orders = useStream((s) => s.orders)
  const { confirm } = useConfirm()
  const bySymbol = useMemo(() => new Map(symbols.map((s) => [s.name, s])), [symbols])
  const openPnl = positions.reduce((sum, p) => sum + p.profit + p.swap, 0)

  const flatten = () =>
    void confirm({
      title: 'Flatten all',
      tone: 'danger',
      always: true,
      confirmLabel: `Close ${positions.length} and cancel ${orders.length}`,
      rows: [
        ['Positions to close', String(positions.length)],
        ['Pending orders to cancel', String(orders.length)],
        ['Open P/L', <span className={pnlClass(openPnl)}>{signedMoney(openPnl)}</span>],
      ],
      run: async () => {
        positions.forEach((p) => expectedRemovals.add(p.ticket))
        orders.forEach((o) => expectedRemovals.add(o.ticket))
        const r = await api.flatten()
        if (r.errors.length) {
          r.errors.forEach((e) => toast('error', e))
          throw new Error(`${r.errors.length} action(s) failed. See the notifications.`)
        }
        toast('success', `Flattened: ${r.closed.length} closed, ${r.cancelled.length} cancelled`)
      },
    })

  const tabs: [Tab, string][] = [
    ['positions', `Positions (${positions.length})`],
    ['orders', `Pending (${orders.length})`],
    ['history', 'History'],
    ['journal', 'Journal'],
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center border-b border-line px-1">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t)
              onCollapsedChange?.(false)
            }}
            className={`border-b-2 px-3 py-2 text-[12px] ${t === tab && !collapsed ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 pr-2">
          {positions.length > 0 && (
            <span className="text-[12px] text-muted">
              Open P/L <span className={`num ${pnlClass(openPnl)}`}>{signedMoney(openPnl)}</span>
            </span>
          )}
          <button
            type="button"
            disabled={positions.length + orders.length === 0}
            onClick={flatten}
            className="rounded border border-down/50 px-2 py-0.5 text-[11px] font-semibold text-down hover:bg-down/10 disabled:opacity-30"
          >
            Flatten all
          </button>
          {onCollapsedChange && (
            <PanelToggle
              direction={collapsed ? 'up' : 'down'}
              label={collapsed ? 'Show bottom panel' : 'Hide bottom panel'}
              onClick={() => onCollapsedChange(!collapsed)}
            />
          )}
        </div>
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${collapsed ? 'hidden' : ''}`}>
        {tab === 'positions' && <PositionsTab bySymbol={bySymbol} onSelectSymbol={onSelectSymbol} allowNoSlOverride={allowNoSlOverride} />}
        {tab === 'orders' && <OrdersTab bySymbol={bySymbol} onSelectSymbol={onSelectSymbol} allowNoSlOverride={allowNoSlOverride} />}
        {tab === 'history' && <HistoryTab bySymbol={bySymbol} />}
        {tab === 'journal' && <JournalTab />}
      </div>
    </div>
  )
}
