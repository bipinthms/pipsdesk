import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useStream } from '../api/stream'
import type { SymbolInfo } from '../api/types'
import { price } from '../lib/format'
import { PanelToggle } from './PanelToggle'

const DAY_OPEN_REFRESH_MS = 5 * 60_000

interface Props {
  symbols: SymbolInfo[]
  watchlist: string[]
  active: string
  onSelect: (symbol: string) => void
  onChange: (watchlist: string[]) => void
  onCollapse?: () => void
}

/** Today's D1 open per symbol, for the change column. */
function useDayOpens(names: string[]): Record<string, number> {
  const [opens, setOpens] = useState<Record<string, number>>({})
  const key = names.join(',')
  useEffect(() => {
    let cancelled = false
    const fetchAll = () =>
      names.forEach((n) =>
        api.candles(n, 'D1', 1).then(
          (r) => {
            const open = r.candles[0]?.open
            if (!cancelled && open !== undefined) setOpens((o) => ({ ...o, [n]: open }))
          },
          () => {},
        ),
      )
    fetchAll()
    const timer = setInterval(fetchAll, DAY_OPEN_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [key])
  return opens
}

function Row({ info, active, dayOpen, onSelect, onRemove }: {
  info: SymbolInfo
  active: boolean
  dayOpen: number | undefined
  onSelect: () => void
  onRemove: () => void
}) {
  const tick = useStream((s) => s.ticks[info.name])
  const prev = useRef<number | undefined>(undefined)
  const [dir, setDir] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    if (!tick) return
    if (prev.current !== undefined && tick.bid !== prev.current) setDir(tick.bid > prev.current ? 'up' : 'down')
    prev.current = tick.bid
  }, [tick])

  const change = tick && dayOpen ? ((tick.bid - dayOpen) / dayOpen) * 100 : undefined
  return (
    <li
      className={`group flex cursor-pointer items-center gap-2 border-l-2 px-3 py-1.5 ${
        active ? 'border-accent bg-panel-2' : 'border-transparent hover:bg-panel-2'
      }`}
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">{info.name}</div>
        <div className={`num text-[11px] ${change === undefined ? 'text-muted' : change >= 0 ? 'text-up' : 'text-down'}`}>
          {change === undefined ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
        </div>
      </div>
      <div className="num text-right">
        <div className={dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : ''}>
          {tick ? price(tick.bid, info.digits) : '—'}
        </div>
        <div className="text-[11px] text-muted">{tick ? price(tick.ask, info.digits) : ''}</div>
      </div>
      <button
        type="button"
        className="invisible text-muted group-hover:visible hover:text-down"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove ${info.name}`}
        title="Remove from watchlist"
      >
        ×
      </button>
    </li>
  )
}

export function Watchlist({ symbols, watchlist, active, onSelect, onChange, onCollapse }: Props) {
  const [query, setQuery] = useState('')
  const byName = useMemo(() => new Map(symbols.map((s) => [s.name, s])), [symbols])
  const dayOpens = useDayOpens(watchlist)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return symbols
      .filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .slice(0, 12)
  }, [query, symbols])

  const pick = (name: string) => {
    if (!watchlist.includes(name)) onChange([...watchlist, name])
    onSelect(name)
    setQuery('')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex items-center gap-1 border-b border-line p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) pick(results[0].name)
            if (e.key === 'Escape') setQuery('')
          }}
          placeholder="Search symbols…"
          className="min-w-0 flex-1 rounded border border-line bg-panel-2 px-2 py-1 outline-none focus:border-accent"
          aria-label="Search symbols"
        />
        {onCollapse && <PanelToggle direction="left" label="Hide watchlist" onClick={onCollapse} />}
        {results.length > 0 && (
          <ul className="absolute right-2 left-2 z-20 mt-1 max-h-72 overflow-auto rounded border border-line bg-panel shadow-lg">
            {results.map((s) => (
              <li
                key={s.name}
                className="flex cursor-pointer items-baseline justify-between gap-2 px-2 py-1.5 hover:bg-panel-2"
                onClick={() => pick(s.name)}
              >
                <span className="font-medium">{s.name}</span>
                <span className="truncate text-[11px] text-muted">{s.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted">
        <span>Symbol</span>
        <span>Bid / Ask</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {watchlist.map((name) => {
          const info = byName.get(name)
          if (!info) return null
          return (
            <Row
              key={name}
              info={info}
              active={name === active}
              dayOpen={dayOpens[name]}
              onSelect={() => onSelect(name)}
              onRemove={() => onChange(watchlist.filter((n) => n !== name))}
            />
          )
        })}
        {watchlist.length === 0 && <li className="px-3 py-4 text-center text-muted">Search to add symbols</li>}
      </ul>
    </div>
  )
}
