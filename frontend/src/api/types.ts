// Hand-written mirror of backend/schemas.py. Keep the two in sync.
// Times are MT5 server time as epoch seconds.

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1'
export const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1']

export type Side = 'buy' | 'sell'
export type PendingType = 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop'

export interface Health {
  connected: boolean
  mock: boolean
  message: string | null
  retry_in_seconds: number | null
}

export interface AccountInfo {
  currency: string
  balance: number
  equity: number
  margin: number
  margin_free: number
  margin_level: number | null
  profit: number
  leverage: number
  trade_allowed: boolean
  mock: boolean
  account_mode: 'demo' | 'contest' | 'real'
}

export interface SymbolInfo {
  name: string
  description: string
  digits: number
  point: number
  contract_size: number
  tick_size: number
  tick_value: number
  volume_min: number
  volume_max: number
  volume_step: number
  stops_level: number
  spread: number
  currency_base: string
  currency_profit: string
  trade_allowed: boolean
}

export interface Tick {
  symbol: string
  time: number
  time_msc: number
  bid: number
  ask: number
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface CandlesResponse {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
}

export interface Position {
  ticket: number
  symbol: string
  side: Side
  volume: number
  price_open: number
  price_current: number
  sl: number | null
  tp: number | null
  profit: number
  swap: number
  time: number
  comment: string
}

export interface PendingOrder {
  ticket: number
  symbol: string
  type: PendingType
  volume: number
  price_open: number
  price_current: number
  sl: number | null
  tp: number | null
  time_setup: number
  comment: string
}

export interface TradeResult {
  retcode: number
  message: string
  order: number
  deal: number
  volume: number
  price: number
}

// --- WebSocket /ws/stream (mirrors the Stream* models in schemas.py) ---------

export type StreamMessage =
  | { type: 'status'; status: Health }
  | { type: 'account'; account: AccountInfo }
  | { type: 'risk'; risk: RiskStatus }
  | { type: 'positions'; positions: Position[] }
  | { type: 'orders'; orders: PendingOrder[] }
  | { type: 'tick'; tick: Tick }
  | { type: 'candle'; symbol: string; timeframe: Timeframe; candles: Candle[] }
  | { type: 'error'; message: string; symbol: string | null }

export type ClientMessage =
  | { type: 'subscribe'; symbols: string[] }
  | { type: 'chart'; symbol: string | null; timeframe: Timeframe }
  | { type: 'charts'; charts: { symbol: string; timeframe: Timeframe }[] }

// --- Risk (mirrors backend/risk.py) ------------------------------------------

export type RiskLevel = 'ok' | 'warn' | 'danger' | 'breached'

export interface LimitStatus {
  limit_pct: number
  base: number
  limit_amount: number
  floor: number
  used: number
  remaining: number
  used_pct: number
  level: RiskLevel
}

export interface RiskStatus {
  daily: LimitStatus | null
  drawdown: LimitStatus | null
  day_key: string | null
  day_start_balance: number | null
  day_start_equity: number | null
  day_anchor_late: boolean
  initial_balance: number | null
  initial_balance_source: 'settings' | 'observed' | 'unknown'
  actions_last_minute: number
  max_actions_per_minute: number
  news_blackout_active: boolean
  next_news_event_utc: number | null
}

export interface RiskDecision {
  allowed: boolean
  violations: string[]
  warnings: string[]
  trade_risk: number | null
  trade_risk_pct: number | null
  trade_reward: number | null
  reward_risk: number | null
  worst_case_equity: number | null
  daily_floor: number | null
  drawdown_floor: number | null
}

// --- Trading (mirrors backend/schemas.py) --------------------------------------

export type OrderType = 'market' | 'limit' | 'stop'

export interface OrderRequest {
  symbol: string
  side: Side
  order_type: OrderType
  volume: number
  price?: number | null
  sl?: number | null
  tp?: number | null
  allow_no_sl?: boolean
  deviation?: number
  comment?: string
}

export interface ModifyPositionRequest {
  sl: number | null
  tp: number | null
  allow_no_sl?: boolean
}

export interface ModifyOrderRequest extends ModifyPositionRequest {
  price: number
}

export interface TradeResponse {
  result: TradeResult
  warnings: string[]
}

export interface FlattenResponse {
  closed: number[]
  cancelled: number[]
  errors: string[]
}

export interface OrderCheckRequest {
  action: 'open' | 'pending' | 'modify_position' | 'modify_order'
  symbol?: string
  side?: Side
  volume?: number
  price?: number | null
  sl?: number | null
  tp?: number | null
  ticket?: number
  allow_no_sl?: boolean
}

export interface Deal {
  ticket: number
  order: number
  position_id: number
  symbol: string
  side: Side | null
  entry: 'in' | 'out' | 'other'
  volume: number
  price: number
  profit: number
  commission: number
  swap: number
  time: number
  reason: string
  comment: string
}

export type JournalStatus = 'accepted' | 'blocked' | 'rejected' | 'error' | 'info'

export interface JournalEntry {
  id: number
  time_utc: number
  action: string
  status: JournalStatus
  symbol: string | null
  side: string | null
  volume: number | null
  price: number | null
  sl: number | null
  tp: number | null
  ticket: number | null
  retcode: number | null
  risk_amount: number | null
  reason: string
  note: string
  details: Record<string, unknown>
}

export interface RiskSettings {
  daily_loss_pct: number
  daily_loss_basis: 'higher_of_balance_equity' | 'balance' | 'equity'
  max_drawdown_pct: number
  drawdown_mode: 'static' | 'trailing'
  initial_balance: number | null
  max_risk_per_trade_pct: number
  require_stop_loss: boolean
  max_open_positions: number
  max_total_lots: number
  max_actions_per_minute: number
  news_blackout_enabled: boolean
  news_blackout_minutes: number
  commission_per_lot: number
  day_reset_time: string
  day_reset_timezone: string
  warn_at_pct_used: number
  danger_at_pct_used: number
}

export interface NewsEvent {
  id: number
  time_utc: number
  title: string
}
