import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import { useStream } from '../api/stream'
import type { NewsEvent, RiskSettings } from '../api/types'
import { useConfirm } from './Confirm'
import { toast } from './Toasts'

type Key = keyof RiskSettings
type Draft = Record<Key, string | boolean>

interface FieldDef {
  key: Key
  label: string
  hint?: string
  kind: 'number' | 'bool' | 'select' | 'text'
  options?: [string, string][]
  step?: number
  suffix?: string
  optional?: boolean
  /** Which direction relaxes the rule: flagged when saving. */
  looser?: 'up' | 'down' | 'off'
}

const SECTIONS: [string, FieldDef[]][] = [
  ['Account', [
    { key: 'initial_balance', label: 'Initial balance', kind: 'number', optional: true, suffix: '$',
      hint: "Your FundingPips account size; max drawdown is measured from it. Blank = the account's first deposit in MT5 history (live trading is blocked if there is none)." },
  ]],
  ['Daily loss limit', [
    { key: 'daily_loss_pct', label: 'Max daily loss', kind: 'number', step: 0.1, suffix: '%', looser: 'up' },
    { key: 'daily_loss_basis', label: 'Measured from', kind: 'select', options: [
      ['higher_of_balance_equity', 'Higher of balance / equity at reset'], ['balance', 'Balance at reset'], ['equity', 'Equity at reset']] },
    { key: 'day_reset_time', label: 'Day resets at', kind: 'text', hint: 'HH:MM. A change starts at the next reset; today keeps its anchor.' },
    { key: 'day_reset_timezone', label: 'Reset timezone', kind: 'text', hint: '"server" = MT5 server clock, or an IANA zone like Europe/Prague' },
  ]],
  ['Max drawdown', [
    { key: 'max_drawdown_pct', label: 'Max drawdown', kind: 'number', step: 0.5, suffix: '%', looser: 'up' },
    { key: 'drawdown_mode', label: 'Mode', kind: 'select', options: [['static', 'Static (from initial balance)'], ['trailing', 'Trailing (from equity high)']] },
  ]],
  ['Per trade', [
    { key: 'max_risk_per_trade_pct', label: 'Max risk per trade', kind: 'number', step: 0.1, suffix: '%', looser: 'up' },
    { key: 'require_stop_loss', label: 'Require a stop loss (override per order)', kind: 'bool', looser: 'off' },
    { key: 'commission_per_lot', label: 'Commission per lot (round turn)', kind: 'number', step: 0.5, suffix: '$', looser: 'down',
      hint: 'Added to every risk and worst-case calculation.' },
  ]],
  ['Exposure and pace', [
    { key: 'max_open_positions', label: 'Max open positions + pending orders', kind: 'number', looser: 'up' },
    { key: 'max_total_lots', label: 'Max total lots', kind: 'number', step: 0.1, looser: 'up' },
    { key: 'max_actions_per_minute', label: 'Max order actions per minute', kind: 'number', looser: 'up', hint: 'Hard ceiling: 30.' },
  ]],
  ['News blackout', [
    { key: 'news_blackout_enabled', label: 'Block new orders around news events', kind: 'bool', looser: 'off' },
    { key: 'news_blackout_minutes', label: 'Window (± minutes)', kind: 'number', looser: 'down' },
  ]],
  ['Account bar meters', [
    { key: 'warn_at_pct_used', label: 'Amber when limit used ≥', kind: 'number', suffix: '%' },
    { key: 'danger_at_pct_used', label: 'Red when limit used ≥', kind: 'number', suffix: '%' },
  ]],
]
const FIELDS = SECTIONS.flatMap(([, f]) => f)

function toDraft(s: RiskSettings): Draft {
  return Object.fromEntries(
    FIELDS.map((f) => [f.key, f.kind === 'bool' ? Boolean(s[f.key]) : s[f.key] === null ? '' : String(s[f.key])]),
  ) as Draft
}

function fromDraft(d: Draft, base: RiskSettings): RiskSettings {
  const out: Record<string, unknown> = { ...base }
  for (const f of FIELDS) {
    const v = d[f.key]
    out[f.key] = f.kind === 'bool' ? v : f.kind === 'number' ? (v === '' && f.optional ? null : Number(v)) : v
  }
  return out as unknown as RiskSettings
}

function display(f: FieldDef, v: unknown): string {
  if (v === null || v === '') return '—'
  if (f.kind === 'bool') return v ? 'On' : 'Off'
  if (f.kind === 'select') return f.options?.find(([k]) => k === v)?.[1] ?? String(v)
  return `${v}${f.suffix === '%' ? '%' : ''}`
}

function isLooser(f: FieldDef, from: unknown, to: unknown): boolean {
  if (f.looser === 'off') return from === true && to === false
  if (typeof from !== 'number' || typeof to !== 'number') return false
  return f.looser === 'up' ? to > from : f.looser === 'down' ? to < from : false
}

const inputCls = 'num w-40 rounded border border-line bg-panel-2 px-2 py-1 text-right outline-none focus:border-accent'

export function SettingsPage({ onBack, onSaved }: { onBack: () => void; onSaved: (s: RiskSettings) => void }) {
  const { confirm } = useConfirm()
  const [saved, setSaved] = useState<RiskSettings>()
  const [draft, setDraft] = useState<Draft>()
  const [error, setError] = useState<string>()
  const accountChanged = useStream((s) => s.risk?.account_changed === true)

  useEffect(() => {
    api.riskSettings().then((s) => {
      setSaved(s)
      setDraft(toDraft(s))
    }, (e: Error) => setError(e.message))
  }, [])

  const next = useMemo(() => (saved && draft ? fromDraft(draft, saved) : undefined), [saved, draft])
  const changes = useMemo(
    () => (saved && next ? FIELDS.filter((f) => saved[f.key] !== next[f.key]) : []),
    [saved, next],
  )

  const save = () => {
    if (!saved || !next || (changes.length === 0 && !accountChanged)) return
    const looser = changes.filter((f) => isLooser(f, saved[f.key], next[f.key]))
    const summary = FIELDS.filter((f) => ['initial_balance', 'daily_loss_pct', 'max_drawdown_pct', 'max_risk_per_trade_pct'].includes(f.key))
    void confirm({
      title: changes.length
        ? `Save ${changes.length} risk setting change${changes.length > 1 ? 's' : ''}`
        : 'Confirm these limits for this account',
      tone: looser.length ? 'danger' : 'neutral',
      always: true,
      confirmLabel: 'Save settings',
      rows: changes.length
        ? changes.map((f) => [
            f.label,
            <span className={isLooser(f, saved[f.key], next[f.key]) ? 'text-warn' : ''}>
              {display(f, saved[f.key])} → {display(f, next[f.key])}
            </span>,
          ])
        : summary.map((f) => [f.label, display(f, next[f.key])]),
      warnings: looser.length
        ? [`This relaxes ${looser.length} limit${looser.length > 1 ? 's' : ''} (amber). Make sure it still matches your prop firm's rules.`]
        : undefined,
      run: async () => {
        try {
          const s = await api.saveRiskSettings(next)
          setSaved(s)
          setDraft(toDraft(s))
          setError(undefined)
          onSaved(s)
          toast('success', 'Risk settings saved')
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : String(e)
          setError(msg)
          throw e
        }
      },
    })
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <button type="button" onClick={onBack} className="rounded border border-line px-2 py-1 text-muted hover:text-fg">
          ← Back to trading
        </button>
        <h1 className="text-[15px] font-semibold">Settings</h1>
        <div className="ml-auto flex items-center gap-2">
          {changes.length > 0 && <span className="text-[12px] text-warn">{changes.length} unsaved change{changes.length > 1 ? 's' : ''}</span>}
          <button type="button" disabled={!changes.length} onClick={() => saved && setDraft(toDraft(saved))}
            className="rounded border border-line px-3 py-1 text-muted hover:text-fg disabled:opacity-40">
            Revert
          </button>
          <button type="button" disabled={!changes.length && !accountChanged} onClick={save}
            className="rounded bg-accent px-3 py-1 font-semibold text-white disabled:opacity-40">
            {changes.length || !accountChanged ? 'Save' : 'Confirm for this account'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
          {error && <p className="rounded border border-down/40 bg-down/10 px-3 py-2 text-down">{error}</p>}
          {accountChanged && (
            <p className="rounded border border-down/50 bg-down/10 px-3 py-2 text-down">
              The terminal is on a different MT5 account from the one these limits were recorded for. New orders are
              blocked until you check them, especially <b>Initial balance</b>, and save. Closing positions still works.
            </p>
          )}
          <p className="text-[12px] text-muted">
            These limits are enforced by the backend risk engine on every order action. Set them to match your FundingPips
            account rules (check your dashboard), or tighter.
          </p>
          {draft && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {SECTIONS.map(([title, fields]) => (
                <Section key={title} title={title}>
                  {fields.map((f) => (
                    <FieldRow key={f.key} f={f} value={draft[f.key]} changed={changes.includes(f)}
                      onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                  ))}
                </Section>
              ))}
              <NewsSection />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </section>
  )
}

function FieldRow({ f, value, changed, onChange }: { f: FieldDef; value: string | boolean; changed: boolean; onChange: (v: string | boolean) => void }) {
  const id = `setting-${f.key}`
  const control =
    f.kind === 'bool' ? (
      <input id={id} type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
    ) : f.kind === 'select' ? (
      <select id={id} value={value as string} onChange={(e) => onChange(e.target.value)} className="w-56 rounded border border-line bg-panel-2 px-2 py-1">
        {f.options!.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    ) : (
      <span className="flex items-center gap-1">
        {f.suffix === '$' && <span className="text-muted">$</span>}
        <input id={id} className={inputCls} inputMode={f.kind === 'number' ? 'decimal' : 'text'} value={value as string}
          placeholder={f.optional ? 'auto' : ''} onChange={(e) => onChange(e.target.value)} />
        {f.suffix === '%' && <span className="text-muted">%</span>}
      </span>
    )
  return (
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={id} className="flex flex-col">
        <span className={changed ? 'font-medium text-warn' : ''}>{f.label}</span>
        {f.hint && <span className="text-[11px] text-muted">{f.hint}</span>}
      </label>
      {control}
    </div>
  )
}

// ---------------------------------------------------------------------------

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function NewsSection() {
  const [events, setEvents] = useState<NewsEvent[]>([])
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)))
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string>()
  const now = Date.now() / 1000

  const refresh = () => api.news().then(setEvents, (e: Error) => setError(e.message))
  useEffect(() => void refresh(), [])

  const add = async () => {
    const t = new Date(when).getTime() / 1000 // datetime-local is the browser's local time
    if (!Number.isFinite(t) || !title.trim()) return setError('Enter a time and a title.')
    try {
      await api.addNews(Math.round(t), title.trim())
      setTitle('')
      setError(undefined)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Section title="News events (blackout)">
      <p className="text-[11px] text-muted">
        Enter high-impact events in your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}). New orders are blocked within the
        window above.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Event time"
          className="rounded border border-line bg-panel-2 px-2 py-1" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. US NFP" aria-label="Event title"
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          className="min-w-0 flex-1 rounded border border-line bg-panel-2 px-2 py-1" maxLength={120} />
        <button type="button" onClick={() => void add()} className="rounded bg-accent px-3 py-1 font-semibold text-white">Add</button>
      </div>
      {error && <p className="text-[12px] text-down">{error}</p>}
      <ul className="flex flex-col gap-1">
        {events.length === 0 && <li className="text-[12px] text-muted">No events.</li>}
        {events.map((e) => (
          <li key={e.id} className={`flex items-center gap-2 rounded bg-panel-2 px-2 py-1 text-[12px] ${e.time_utc < now - 3600 ? 'opacity-50' : ''}`}>
            <span className="num">{new Date(e.time_utc * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span className="num text-muted">({new Date(e.time_utc * 1000).toISOString().slice(11, 16)} UTC)</span>
            <span className="flex-1 truncate">{e.title}</span>
            <button type="button" aria-label={`Delete ${e.title}`} className="text-muted hover:text-down"
              onClick={() => api.deleteNews(e.id).then(refresh, (err: Error) => setError(err.message))}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}
