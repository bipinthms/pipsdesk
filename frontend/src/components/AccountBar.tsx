import type { ConnectionState } from '../api/stream'
import type { AccountInfo, Health, LimitStatus, RiskLevel, RiskStatus } from '../api/types'
import type { Theme } from '../hooks/useTheme'
import { money, signedMoney } from '../lib/format'

interface Props {
  account: AccountInfo | undefined
  risk: RiskStatus | undefined
  health: Health | undefined
  connection: ConnectionState
  theme: Theme
  onToggleTheme: () => void
  onOpenSettings: () => void
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg'
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`num text-[13px] ${color}`}>{value}</span>
    </div>
  )
}

const LEVEL_TEXT: Record<RiskLevel, string> = { ok: 'text-up', warn: 'text-warn', danger: 'text-down', breached: 'text-down' }
const LEVEL_BAR: Record<RiskLevel, string> = { ok: 'bg-up', warn: 'bg-warn', danger: 'bg-down', breached: 'bg-down' }

/** Remaining room before a prop-firm limit, colour-coded by how much is used. */
function LimitMeter({ label, limit, ccy, note }: { label: string; limit: LimitStatus | null; ccy: string; note?: string }) {
  if (!limit) {
    return <Stat label={label} value="—" />
  }
  const title =
    `${limit.limit_pct}% of ${money(limit.base, ccy)} = ${money(limit.limit_amount, ccy)}\n` +
    `Equity must stay above ${money(limit.floor, ccy)}\n` +
    `Used ${money(limit.used, ccy)} (${limit.used_pct.toFixed(0)}%)` +
    (note ? `\n${note}` : '')
  return (
    <div className="flex w-32 flex-col leading-tight" title={title}>
      <span className="text-[10px] uppercase tracking-wide text-muted">
        {label}
        {note && <span className="ml-1 text-warn">*</span>}
      </span>
      <span className={`num text-[13px] ${LEVEL_TEXT[limit.level]}`}>
        {limit.level === 'breached' ? 'BREACHED' : money(limit.remaining, ccy)}
      </span>
      <span className="mt-0.5 h-1 w-full overflow-hidden rounded bg-panel-2">
        <span
          className={`block h-full ${LEVEL_BAR[limit.level]}`}
          style={{ width: `${Math.min(100, Math.max(0, limit.used_pct))}%` }}
        />
      </span>
    </div>
  )
}

/** Always make it obvious whether orders go to a simulator, a demo account or real money. */
function ModeBadge({ mock, mode }: { mock: boolean | undefined; mode: AccountInfo['account_mode'] | undefined }) {
  if (mock === undefined) return null
  const [text, cls, title] = mock
    ? ['MOCK', 'border-warn/50 bg-warn/10 text-warn', 'Simulated prices and fills (MT5_MOCK=1)']
    : mode === 'real'
      ? ['LIVE · REAL', 'border-down bg-down text-white', 'Connected to a real-money account']
      : mode === 'contest'
        ? ['LIVE · CONTEST', 'border-accent/50 bg-accent/10 text-accent', 'Connected to a contest account']
        : ['LIVE · DEMO', 'border-accent/50 bg-accent/10 text-accent', 'Connected to a demo account']
  return (
    <span title={title} className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${cls}`}>
      {text}
    </span>
  )
}

function ConnectionStatus({ health, connection }: Pick<Props, 'health' | 'connection'>) {
  let dot = 'bg-up'
  let text = 'Connected'
  let title = 'MT5 terminal connected'
  if (connection === 'closed') {
    dot = 'bg-down'
    text = 'Backend offline'
    title = 'Cannot reach the backend. Reconnecting…'
  } else if (connection === 'connecting' || !health) {
    dot = 'bg-muted'
    text = 'Connecting…'
  } else if (!health.connected) {
    dot = 'bg-down'
    text = 'MT5 disconnected'
    title = health.message ?? ''
    if (health.retry_in_seconds) text += ` · retry ${Math.ceil(health.retry_in_seconds)}s`
  }
  return (
    <div className="flex items-center gap-2" title={title} role="status">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="text-muted">{text}</span>
    </div>
  )
}

export function AccountBar({ account, risk, health, connection, theme, onToggleTheme, onOpenSettings }: Props) {
  const ccy = account?.currency ?? 'USD'
  return (
    <header className="flex h-12 shrink-0 items-center gap-6 border-b border-line bg-panel px-4">
      <div className="flex items-center gap-2 font-semibold tracking-tight">
        <span className="grid h-6 w-6 place-items-center rounded bg-accent text-[11px] text-white">P</span>
        Pipdesk
      </div>
      <ModeBadge mock={health?.mock} mode={account?.account_mode} />
      {risk?.account_changed && (
        <button
          type="button"
          onClick={onOpenSettings}
          title="The terminal is on a different MT5 account from the one the risk limits were recorded for. New orders are blocked until you confirm the limits."
          className="rounded border border-down bg-down px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white"
        >
          ACCOUNT CHANGED · CONFIRM LIMITS
        </button>
      )}

      {account && connection === 'open' ? (
        <div className="flex items-center gap-6">
          <Stat label="Balance" value={money(account.balance, ccy)} />
          <Stat label="Equity" value={money(account.equity, ccy)} />
          <Stat
            label="Open P/L"
            value={signedMoney(account.profit, ccy)}
            tone={account.profit > 0 ? 'up' : account.profit < 0 ? 'down' : undefined}
          />
          <Stat
            label="Today's P/L"
            value={risk?.day_start_equity == null ? '—' : signedMoney(account.equity - risk.day_start_equity, ccy)}
            tone={
              risk?.day_start_equity == null
                ? undefined
                : account.equity > risk.day_start_equity
                  ? 'up'
                  : account.equity < risk.day_start_equity
                    ? 'down'
                    : undefined
            }
          />
          <LimitMeter
            label="Daily loss left"
            limit={risk?.daily ?? null}
            ccy={ccy}
            note={
              risk?.day_start_rebuilt
                ? "The app wasn't running at the reset: the day start was rebuilt from MT5 history (trades closed since the reset, and positions open at it priced from M1 bars)."
                : risk?.day_anchor_late
                  ? "Day start was recorded late (app wasn't running at the reset) and couldn't be rebuilt from history: it uses the account as first seen today."
                  : undefined
            }
          />
          <LimitMeter
            label="Drawdown left"
            limit={risk?.drawdown ?? null}
            ccy={ccy}
            note={
              risk?.initial_balance_source === 'observed'
                ? 'Initial balance taken from the first balance seen. Set it in Settings.'
                : undefined
            }
          />
          <Stat label="Margin" value={money(account.margin, ccy)} />
          <Stat label="Free margin" value={money(account.margin_free, ccy)} />
          <Stat
            label="Margin level"
            value={account.margin_level === null ? '—' : `${account.margin_level.toFixed(0)}%`}
          />
        </div>
      ) : (
        <span className="text-muted">Account unavailable</span>
      )}

      <div className="ml-auto flex items-center gap-4">
        <ConnectionStatus health={health} connection={connection} />
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded border border-line px-2 py-1 text-muted hover:text-fg"
        >
          Settings
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          className="rounded border border-line px-2 py-1 text-muted hover:text-fg"
          title="Toggle theme"
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
    </header>
  )
}
