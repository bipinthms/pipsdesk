import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api/client'
import { stream, useStream } from './api/stream'
import type { RiskSettings, SymbolInfo, Timeframe } from './api/types'
import { AccountBar } from './components/AccountBar'
import { BottomPanel } from './components/BottomPanel'
import { Chart } from './components/Chart'
import { isLayout, layoutCell, layoutGrid, LayoutPicker, MAX_PANES, paneCount as panesIn, type Layout } from './components/ChartTools'
import { ConfirmProvider } from './components/Confirm'
import { OrderPanel } from './components/OrderPanel'
import { PanelRail } from './components/PanelToggle'
import { SettingsPage } from './components/SettingsPage'
import { toast, Toasts } from './components/Toasts'
import { Watchlist } from './components/Watchlist'
import { useTheme } from './hooks/useTheme'
import { useTradeEvents } from './hooks/useTradeEvents'
import { load, save } from './lib/storage'

/** Toasts when the backend or the MT5 terminal drops or comes back. */
function useConnectionToasts() {
  const connection = useStream((s) => s.state)
  const connected = useStream((s) => s.status?.connected)
  const message = useStream((s) => s.status?.message)
  const prev = useRef({ connection, connected })

  useEffect(() => {
    const p = prev.current
    if (p.connection === 'open' && connection === 'closed') toast('error', 'Lost connection to the backend. Reconnecting…')
    if (p.connection === 'closed' && connection === 'open') toast('success', 'Backend connection restored.')
    if (p.connected === true && connected === false) toast('error', `MT5 disconnected: ${message ?? 'unknown reason'}`)
    if (p.connected === false && connected === true) toast('success', 'MT5 terminal reconnected.')
    prev.current = { connection, connected }
  }, [connection, connected, message])

  useEffect(() => stream.on('error', (m) => toast('warn', m.message)), [])
}

interface Pane {
  symbol: string
  timeframe: Timeframe
}

/** Saved panes, or the single chart from before layouts existed plus the same symbol on other timeframes. */
function initialPanes(): Pane[] {
  const symbol = load('pipdesk.symbol', 'EURUSD')
  const timeframe = load<Timeframe>('pipdesk.timeframe', 'M15')
  const saved = load<Pane[]>('pipdesk.panes', [])
  const others: Timeframe[] = ['H1', 'H4', 'D1', 'M5', 'M1', 'M15', 'H1']
  const defaults: Pane[] = [{ symbol, timeframe }, ...others.slice(0, MAX_PANES - 1).map((tf) => ({ symbol, timeframe: tf }))]
  return defaults.map((d, i) => saved[i] ?? d)
}

function Desk() {
  const [theme, toggleTheme] = useTheme()
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [watchlist, setWatchlist] = useState<string[] | null>(() => load<string[] | null>('pipdesk.watchlist', null))
  const [layout, setLayout] = useState<Layout>(() => {
    const saved = load<unknown>('pipdesk.layout', '1')
    return isLayout(saved) ? saved : '1'
  })
  const [panes, setPanes] = useState<Pane[]>(initialPanes)
  const [activePane, setActivePane] = useState(() => load('pipdesk.activePane', 0))
  const paneCount = panesIn(layout)
  const active = Math.min(activePane, paneCount - 1)
  const symbol = panes[active]!.symbol

  const account = useStream((s) => s.account)
  const risk = useStream((s) => s.risk)
  const health = useStream((s) => s.status)
  const connection = useStream((s) => s.state)
  const [collapsed, setCollapsed] = useState(() =>
    load('pipdesk.collapsed', { watchlist: false, order: false, bottom: false }),
  )
  const setPanel = (panel: keyof typeof collapsed, value: boolean) => setCollapsed((c) => ({ ...c, [panel]: value }))
  const [riskSettings, setRiskSettings] = useState<RiskSettings>()
  const [view, setView] = useState<'desk' | 'settings'>('desk')
  useConnectionToasts()
  useTradeEvents()

  useEffect(() => {
    if (connection === 'open') api.riskSettings().then(setRiskSettings, () => {})
  }, [connection])

  useEffect(() => {
    stream.start()
    return () => stream.stop()
  }, [])

  // Symbol list; retried until the backend answers (it may start after the UI).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const fetchSymbols = () =>
      api.symbols().then(setSymbols, () => {
        timer = setTimeout(fetchSymbols, 3000)
      })
    fetchSymbols()
    return () => clearTimeout(timer)
  }, [])

  // First run: watch every symbol the broker offers (capped).
  const list = useMemo(() => watchlist ?? symbols.slice(0, 20).map((s) => s.name), [watchlist, symbols])

  useEffect(() => save('pipdesk.collapsed', collapsed), [collapsed])
  useEffect(() => save('pipdesk.layout', layout), [layout])
  useEffect(() => save('pipdesk.panes', panes), [panes])
  useEffect(() => save('pipdesk.activePane', active), [active])
  const shownSymbols = panes.slice(0, paneCount).map((p) => p.symbol).join(',')
  useEffect(() => stream.setSymbols([...list, ...shownSymbols.split(',')]), [list, shownSymbols])

  const updatePane = (i: number, patch: Partial<Pane>) =>
    setPanes((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  /** The watchlist, positions and orders tables load a symbol into the active chart. */
  const setSymbol = (s: string) => updatePane(active, { symbol: s })

  const updateWatchlist = (next: string[]) => {
    setWatchlist(next)
    save('pipdesk.watchlist', next)
  }

  const info = symbols.find((s) => s.name === symbol)

  return (
    <div className="flex h-full flex-col">
      <AccountBar
        account={account}
        risk={risk}
        health={health}
        connection={connection}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setView('settings')}
      />
      {view === 'settings' && (
        <div className="min-h-0 flex-1">
          <SettingsPage onBack={() => setView('desk')} onSaved={setRiskSettings} />
        </div>
      )}
      {/* Kept mounted while Settings is open so the chart keeps its state. */}
      <div className={`min-h-0 flex-1 ${view === 'desk' ? 'flex' : 'hidden'}`}>
        {/* Collapsed panels stay mounted (hidden) so they keep their state, e.g. the order draft. */}
        <aside className={`shrink-0 border-r border-line bg-panel ${collapsed.watchlist ? 'w-7' : 'w-60'}`}>
          {collapsed.watchlist && <PanelRail side="left" label="Watchlist" name="watchlist" onExpand={() => setPanel('watchlist', false)} />}
          <div className={collapsed.watchlist ? 'hidden' : 'h-full'}>
            <Watchlist
              symbols={symbols}
              watchlist={list}
              active={symbol}
              onSelect={setSymbol}
              onChange={updateWatchlist}
              onCollapse={() => setPanel('watchlist', true)}
            />
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <section className="grid min-h-0 flex-1 gap-px bg-line" style={layoutGrid(layout)}>
            {panes.slice(0, paneCount).map((p, i) => (
              <div key={i} className="min-h-0 min-w-0 bg-panel" style={layoutCell(layout, i)}>
                <Chart
                  id={String(i)}
                  indicatorsKey={i === 0 ? 'pipdesk.indicators' : `pipdesk.indicators.${i}`}
                  symbol={p.symbol}
                  info={symbols.find((s) => s.name === p.symbol)}
                  timeframe={p.timeframe}
                  onTimeframe={(tf) => updatePane(i, { timeframe: tf })}
                  theme={theme}
                  active={paneCount > 1 && i === active}
                  onActivate={() => setActivePane(i)}
                  toolbar={i === 0 ? <LayoutPicker layout={layout} onChange={setLayout} /> : undefined}
                />
              </div>
            ))}
          </section>
          <section className={`shrink-0 border-t border-line bg-panel ${collapsed.bottom ? '' : 'h-60'}`}>
            <BottomPanel
              symbols={symbols}
              onSelectSymbol={setSymbol}
              collapsed={collapsed.bottom}
              onCollapsedChange={(c) => setPanel('bottom', c)}
            />
          </section>
        </main>
        <aside className={`shrink-0 border-l border-line bg-panel ${collapsed.order ? 'w-7' : 'w-72'}`}>
          {collapsed.order && <PanelRail side="right" label={`Order · ${symbol}`} name="order panel" onExpand={() => setPanel('order', false)} />}
          <div className={collapsed.order ? 'hidden' : 'h-full'}>
            <OrderPanel symbol={symbol} info={info} settings={riskSettings} onCollapse={() => setPanel('order', true)} />
          </div>
        </aside>
      </div>
      <Toasts />
    </div>
  )
}

export default function App() {
  return (
    <ConfirmProvider>
      <Desk />
    </ConfirmProvider>
  )
}
