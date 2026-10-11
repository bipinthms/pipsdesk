import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { stream, useStream } from '../api/stream'
import type { OrderRequest, OrderType, RiskDecision, RiskSettings, Side, SymbolInfo } from '../api/types'
import { trade } from '../lib/actions'
import { onDraftEdit, setDraft } from '../lib/draft'
import { money, price as fmtPrice } from '../lib/format'
import { stopFieldFor } from '../lib/tradeLines'
import {
  lossPerLot,
  lotsForRisk,
  orderLabel,
  pendingPriceError,
  pipsBetween,
  pipSize,
  snapToTick,
  slFromPips,
  tpFromPips,
} from '../lib/trading'
import { useConfirm } from './Confirm'
import { PanelToggle } from './PanelToggle'

interface Props {
  symbol: string
  info: SymbolInfo | undefined
  settings: RiskSettings | undefined
  onCollapse?: () => void
}

const CHECK_DEBOUNCE_MS = 350
const DEVIATION_POINTS = 20

function num(s: string): number | null {
  if (s.trim() === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : NaN
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="flex overflow-hidden rounded border border-line" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={`flex-1 px-2 py-1 text-[12px] ${v === value ? 'bg-panel-2 font-medium text-fg' : 'text-muted hover:text-fg'}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex justify-between text-[11px] text-muted">
        <span>{label}</span>
        {hint && <span className="num">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

const inputCls =
  'num w-full rounded border border-line bg-panel-2 px-2 py-1.5 text-right outline-none focus:border-accent aria-invalid:border-down'

export function OrderPanel({ symbol, info, settings, onCollapse }: Props) {
  const { confirm, oneClick, setOneClick } = useConfirm()
  const tick = useStream((s) => s.ticks[symbol])
  const balance = useStream((s) => s.account?.balance)

  const [side, setSide] = useState<Side>('buy')
  const [type, setType] = useState<OrderType>('market')
  const [priceIn, setPriceIn] = useState('')
  const [volMode, setVolMode] = useState<'lots' | 'risk'>('risk')
  const [lotsIn, setLotsIn] = useState('0.10')
  const [riskIn, setRiskIn] = useState('')
  const [stopMode, setStopMode] = useState<'pips' | 'price'>('pips')
  const [slIn, setSlIn] = useState('')
  const [tpIn, setTpIn] = useState('')
  const [overrideTicked, setAllowNoSl] = useState(false)
  // The override only counts while Settings allows it.
  const allowNoSl = overrideTicked && !!settings?.allow_no_sl_override
  const [check, setCheck] = useState<RiskDecision | null>(null)
  const [sending, setSending] = useState(false)

  // Default risk %: half the per-trade maximum.
  useEffect(() => {
    if (settings && riskIn === '') setRiskIn(String(Math.min(0.5, settings.max_risk_per_trade_pct)))
  }, [settings, riskIn])

  // Prices don't carry over between symbols.
  useEffect(() => {
    setPriceIn('')
    if (stopMode === 'price') {
      setSlIn('')
      setTpIn('')
    }
    setCheck(null)
  }, [symbol])

  // Pre-fill the pending price with the market when switching to limit/stop.
  useEffect(() => {
    if (type !== 'market' && priceIn === '' && tick && info) {
      setPriceIn(fmtPrice(side === 'buy' ? tick.ask : tick.bid, info.digits))
    }
  }, [type, priceIn, tick, info, side])

  // --- derived order (recomputed on every tick) -----------------------------------
  const digits = info?.digits ?? 5
  const marketPrice = tick ? (side === 'buy' ? tick.ask : tick.bid) : null
  const entry = type === 'market' ? marketPrice : num(priceIn)
  const validEntry = entry !== null && Number.isFinite(entry) && entry > 0 ? entry : null

  // NaN marks an invalid entry; null means empty.
  const resolveStop = (input: string, kind: 'sl' | 'tp'): number | null => {
    const v = num(input)
    if (v === null || Number.isNaN(v)) return v
    if (stopMode === 'price') return v
    if (!info || validEntry === null || v <= 0) return NaN
    return kind === 'sl' ? slFromPips(side, validEntry, v, info) : tpFromPips(side, validEntry, v, info)
  }
  const sl = resolveStop(slIn, 'sl')
  const tp = resolveStop(tpIn, 'tp')
  const commission = settings?.commission_per_lot ?? 0

  let volume: number | null = null
  if (volMode === 'lots') {
    const v = num(lotsIn)
    volume = v !== null && v > 0 ? v : null
  } else if (info && balance && validEntry !== null && sl !== null && !Number.isNaN(sl)) {
    const pct = num(riskIn)
    volume = pct && pct > 0 ? lotsForRisk((balance * pct) / 100, validEntry, sl, info, commission) || null : null
  }

  const risk =
    info && validEntry !== null && volume && sl !== null && !Number.isNaN(sl)
      ? lossPerLot(info, validEntry, sl) * volume + commission * volume
      : null
  const reward =
    info && validEntry !== null && volume && tp !== null && !Number.isNaN(tp)
      ? lossPerLot(info, validEntry, tp) * volume - commission * volume
      : null

  const pendingError = tick ? pendingPriceError(side, type, validEntry ?? 0, tick.bid, tick.ask) : null
  const needsSl = (settings?.require_stop_loss ?? true) && sl === null && !allowNoSl
  const inputError =
    !info || !tick
      ? 'Waiting for prices…'
      : pendingError ??
        (Number.isNaN(sl) ? 'Invalid stop loss.' : null) ??
        (Number.isNaN(tp) ? 'Invalid take profit.' : null) ??
        (volMode === 'risk' && sl === null ? 'Set a stop loss to size by risk.' : null) ??
        (volume === null ? (volMode === 'risk' ? 'Risk too small for the minimum volume.' : 'Enter a volume.') : null) ??
        (needsSl ? 'A stop loss is required.' : null)

  // --- authoritative risk check from the backend (debounced) ------------------------
  const latest = useRef({ symbol, side, type, volume, validEntry, sl, tp, allowNoSl })
  latest.current = { symbol, side, type, volume, validEntry, sl, tp, allowNoSl }
  const checkKey = [symbol, side, type, priceIn, volMode, lotsIn, riskIn, stopMode, slIn, tpIn, allowNoSl, inputError === null].join('|')
  useEffect(() => {
    if (inputError !== null) {
      setCheck(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const l = latest.current
      api
        .riskCheck({
          action: l.type === 'market' ? 'open' : 'pending',
          symbol: l.symbol,
          side: l.side,
          volume: l.volume ?? 0,
          price: l.type === 'market' ? null : l.validEntry,
          sl: l.sl,
          tp: l.tp,
          allow_no_sl: l.allowNoSl,
        })
        .then((d) => !cancelled && setCheck(d), () => !cancelled && setCheck(null))
    }, CHECK_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [checkKey])

  // --- share the draft with the chart, and accept edits from dragging its lines ----------
  const okSl = sl !== null && !Number.isNaN(sl) ? sl : null
  const okTp = tp !== null && !Number.isNaN(tp) ? tp : null
  useEffect(() => {
    setDraft(info && validEntry !== null ? { symbol, side, type, entry: validEntry, sl: okSl, tp: okTp, volume } : null)
  }, [info, symbol, side, type, validEntry, okSl, okTp, volume])
  useEffect(() => () => setDraft(null), [])

  const live = useRef({ okSl, okTp, digits, stopMode, side, validEntry, info })
  live.current = { okSl, okTp, digits, stopMode, side, validEntry, info }
  useEffect(
    () =>
      onDraftEdit(({ field, price }) => {
        const { okSl, okTp, digits, stopMode, side, validEntry, info } = live.current
        const f = (v: number | null) => (v === null ? '' : fmtPrice(v, digits))
        if (field === 'entry') {
          setPriceIn(f(price))
          return
        }
        // In pips mode, keep pips as long as the level stays on its own side of entry.
        if (stopMode === 'pips' && info && validEntry !== null && price !== validEntry && stopFieldFor(side, validEntry, price) === field) {
          const pips = String(Number(pipsBetween(validEntry, price, info).toFixed(2)))
          ;(field === 'sl' ? setSlIn : setTpIn)(pips)
          return
        }
        // Otherwise it's an absolute price: switch to price mode, keeping the other level.
        setStopMode('price')
        setSlIn(f(field === 'sl' ? price : okSl))
        setTpIn(f(field === 'tp' ? price : okTp))
      }),
    [],
  )

  const blocked = check !== null && !check.allowed
  const canSubmit = inputError === null && !blocked

  // --- submit -------------------------------------------------------------------------
  const review = () => {
    if (!canSubmit || !info || volume === null || validEntry === null) return
    const req: OrderRequest = {
      // One id per order dialog: pressing confirm again after an unclear reply can't place it twice.
      client_order_id: crypto.randomUUID(),
      symbol,
      side,
      order_type: type,
      volume,
      price: type === 'market' ? null : snapToTick(validEntry, info),
      sl: sl === null ? null : snapToTick(sl, info),
      tp: tp === null ? null : snapToTick(tp, info),
      allow_no_sl: allowNoSl,
      deviation: DEVIATION_POINTS,
    }
    const label = orderLabel(side, type)
    const pips = (p: number | null | undefined) => (p ? ` (${pipsBetween(validEntry, p, info).toFixed(1)} pips)` : '')
    void confirm({
      key: 'order', // one order at a time, whatever its symbol or size
      always: req.sl === null, // no stop loss: the warning is always shown, even in one-click mode
      title: `${label}: ${volume} ${symbol}`,
      tone: side,
      confirmLabel: `${side === 'buy' ? 'Buy' : 'Sell'} ${volume} ${symbol}`,
      rows: [
        ['Entry', type === 'market' ? `≈ ${fmtPrice(validEntry, digits)} (market)` : fmtPrice(validEntry, digits)],
        ['Stop loss', req.sl ? fmtPrice(req.sl, digits) + pips(req.sl) : 'None'],
        ['Take profit', req.tp ? fmtPrice(req.tp, digits) + pips(req.tp) : 'None'],
        ['Risk', risk !== null ? `${money(risk)} (${((risk / (balance ?? 1)) * 100).toFixed(2)}%)` : 'Unlimited'],
        ['Reward : risk', reward !== null && risk ? `${(reward / risk).toFixed(2)} : 1` : '—'],
        ...(check?.worst_case_equity != null
          ? ([['Worst-case equity', money(check.worst_case_equity)]] as [string, string][])
          : []),
      ],
      warnings: check?.warnings,
      run: async () => {
        // Market orders: send the quote at the moment of confirmation, so a fast move
        // beyond DEVIATION_POINTS comes back as a requote instead of a surprise fill.
        const q = stream.ticks[symbol]
        const body = type === 'market' && q ? { ...req, price: side === 'buy' ? q.ask : q.bid } : req
        setSending(true)
        try {
          await trade(
            () => api.placeOrder(body),
            (r) =>
              type === 'market'
                ? `${side === 'buy' ? 'Bought' : 'Sold'} ${r.result.volume} ${symbol} @ ${fmtPrice(r.result.price, digits)} (#${r.result.order})`
                : `${label} #${r.result.order} placed @ ${fmtPrice(req.price ?? 0, digits)}`,
          )
        } finally {
          setSending(false)
        }
        // The order now exists as real chart lines: clear the draft so its lines disappear.
        setAllowNoSl(false)
        setSlIn('')
        setTpIn('')
        if (type !== 'market') setPriceIn('')
      },
    })
  }

  const pip = info ? pipSize(info) : 0
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Order · {symbol}</span>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted" title="Skip confirmation dialogs">
          <input type="checkbox" checked={oneClick} onChange={(e) => setOneClick(e.target.checked)} />
          <span className={oneClick ? 'font-semibold text-warn' : ''}>One-click</span>
        </label>
        {onCollapse && <PanelToggle direction="right" label="Hide order panel" onClick={onCollapse} />}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        <div className="grid grid-cols-2 gap-2">
          {(['sell', 'buy'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              aria-pressed={side === s}
              className={`flex flex-col items-center rounded border px-2 py-1.5 ${
                side === s
                  ? s === 'buy'
                    ? 'border-up bg-up/15 text-up'
                    : 'border-down bg-down/15 text-down'
                  : 'border-line text-muted hover:text-fg'
              }`}
            >
              <span className="text-[11px] font-semibold uppercase">{s}</span>
              <span className="num text-[14px]">{tick ? fmtPrice(s === 'buy' ? tick.ask : tick.bid, digits) : '—'}</span>
            </button>
          ))}
        </div>

        <Segmented label="Order type" value={type} onChange={setType} options={[['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop']]} />

        {type !== 'market' && (
          <Field label={`${type === 'limit' ? 'Limit' : 'Stop'} price`}>
            <input className={inputCls} inputMode="decimal" value={priceIn} onChange={(e) => setPriceIn(e.target.value)} aria-invalid={pendingError !== null} />
          </Field>
        )}

        <div className="flex flex-col gap-1">
          <Segmented label="Volume mode" value={volMode} onChange={setVolMode} options={[['risk', 'Risk %'], ['lots', 'Lots']]} />
          {volMode === 'lots' ? (
            <Field label="Volume (lots)" hint={info ? `step ${info.volume_step}` : undefined}>
              <input className={inputCls} inputMode="decimal" value={lotsIn} onChange={(e) => setLotsIn(e.target.value)} />
            </Field>
          ) : (
            <Field label="Risk (% of balance)" hint={volume ? `= ${volume} lots` : undefined}>
              <input className={inputCls} inputMode="decimal" value={riskIn} onChange={(e) => setRiskIn(e.target.value)} />
            </Field>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <Segmented
            label="Stop entry mode"
            value={stopMode}
            onChange={(m) => {
              setStopMode(m)
              setSlIn('')
              setTpIn('')
            }}
            options={[['pips', 'Pips'], ['price', 'Price']]}
          />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Stop loss" hint={stopMode === 'pips' && sl && !Number.isNaN(sl) ? fmtPrice(sl, digits) : undefined}>
              <input className={inputCls} inputMode="decimal" value={slIn} onChange={(e) => setSlIn(e.target.value)} placeholder={stopMode === 'pips' ? 'pips' : 'price'} aria-invalid={Number.isNaN(sl)} />
            </Field>
            <Field label="Take profit" hint={stopMode === 'pips' && tp && !Number.isNaN(tp) ? fmtPrice(tp, digits) : undefined}>
              <input className={inputCls} inputMode="decimal" value={tpIn} onChange={(e) => setTpIn(e.target.value)} placeholder="optional" aria-invalid={Number.isNaN(tp)} />
            </Field>
          </div>
          {stopMode === 'pips' && info && <span className="text-[10px] text-muted">1 pip = {pip}</span>}
          {sl === null && (settings?.require_stop_loss ?? true) && settings?.allow_no_sl_override && (
            <label className="flex items-center gap-1.5 text-[11px] text-warn">
              <input type="checkbox" checked={overrideTicked} onChange={(e) => setAllowNoSl(e.target.checked)} />
              Trade without a stop loss (override)
            </label>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-y-1 rounded border border-line bg-panel-2 p-2 text-[12px]">
          <dt className="text-muted">Est. risk</dt>
          <dd className="num text-right">
            {risk !== null && balance ? `${money(risk)} · ${((risk / balance) * 100).toFixed(2)}%` : sl === null ? 'Unlimited' : '—'}
          </dd>
          <dt className="text-muted">Reward</dt>
          <dd className="num text-right">{reward !== null ? money(reward) : '—'}</dd>
          <dt className="text-muted">Reward : risk</dt>
          <dd className="num text-right">{reward !== null && risk ? `${(reward / risk).toFixed(2)} : 1` : '—'}</dd>
          <dt className="text-muted">Worst case equity</dt>
          <dd className="num text-right">{check?.worst_case_equity != null ? money(check.worst_case_equity) : '—'}</dd>
        </dl>

        {check?.violations.map((v) => (
          <p key={v} className="rounded border border-down/40 bg-down/10 px-2 py-1.5 text-[12px] text-down">{v}</p>
        ))}
        {check?.allowed && check.warnings.map((w) => (
          <p key={w} className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[12px] text-warn">{w}</p>
        ))}
      </div>

      <div className="border-t border-line p-3">
        <button
          type="button"
          onClick={review}
          disabled={!canSubmit || sending}
          title={inputError ?? (blocked ? 'Blocked by risk rules' : undefined)}
          className={`w-full rounded py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${
            side === 'buy' ? 'bg-up' : 'bg-down'
          }`}
        >
          {sending
            ? 'Sending…'
            : inputError && inputError !== 'Waiting for prices…'
              ? inputError
              : `${oneClick ? '' : 'Review '}${orderLabel(side, type)}${volume ? ` · ${volume}` : ''}`}
        </button>
      </div>
    </div>
  )
}
