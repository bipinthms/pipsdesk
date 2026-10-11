import type {
  AccountInfo,
  CandlesResponse,
  Deal,
  FlattenResponse,
  Health,
  JournalEntry,
  JournalStatus,
  NewsEvent,
  ModifyOrderRequest,
  ModifyPositionRequest,
  OrderCheckRequest,
  OrderRequest,
  PendingOrder,
  Position,
  RiskDecision,
  RiskSettings,
  RiskStatus,
  SymbolInfo,
  Timeframe,
  TradeResponse,
} from './types'
import type { Drawing } from '../lib/drawings'

const BASE = '/api'

export type ErrorKind = 'risk' | 'broker' | 'unknown'
const KINDS: readonly unknown[] = ['risk', 'broker', 'unknown'] satisfies ErrorKind[]

export class ApiError extends Error {
  readonly status: number
  /**
   * 'risk' = blocked by the risk engine, 'broker' = rejected by MT5 / the trade server,
   * 'unknown' = sent, but there's no clear answer whether it was executed: never retry blindly.
   */
  readonly kind: ErrorKind | undefined
  readonly violations: string[]
  readonly retcode: number | undefined

  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.kind = KINDS.includes(body?.kind) ? (body!.kind as ErrorKind) : undefined
    this.violations = Array.isArray(body?.violations) ? (body.violations as string[]) : []
    this.retcode = typeof body?.retcode === 'number' ? body.retcode : undefined
  }
}

function errorMessage(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  // FastAPI validation errors: [{loc, msg, ...}]
  if (Array.isArray(detail)) {
    return detail.map((d) => (d && typeof d === 'object' && 'msg' in d ? String(d.msg) : String(d))).join('; ')
  }
  return fallback
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        // Required by the backend on state-changing requests (CSRF guard).
        'X-Requested-With': 'trading-ui',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // A state-changing request may have reached the backend (and MT5) before the connection failed.
    if (method !== 'GET') {
      throw new ApiError(0, 'No reply from the backend: the request may or may not have been executed. Check Positions and Orders before trying again.', { kind: 'unknown' })
    }
    throw new ApiError(0, 'Backend unreachable. Is the server running?')
  }
  if (!res.ok) {
    let json: Record<string, unknown> | undefined
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, errorMessage(json?.detail, `${res.status} ${res.statusText}`), json)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const api = {
  health: () => request<Health>('GET', '/health'),
  account: () => request<AccountInfo>('GET', '/account'),
  symbols: () => request<SymbolInfo[]>('GET', '/symbols'),
  candles: (symbol: string, timeframe: Timeframe, count = 500, before?: number) =>
    request<CandlesResponse>('GET', `/candles${qs({ symbol, timeframe, count, before })}`),

  positions: () => request<Position[]>('GET', '/positions'),
  orders: () => request<PendingOrder[]>('GET', '/orders'),
  history: (days = 7) => request<Deal[]>('GET', `/history${qs({ days })}`),
  journal: (limit = 200, status?: JournalStatus) => request<JournalEntry[]>('GET', `/journal${qs({ limit, status })}`),

  placeOrder: (body: OrderRequest) => request<TradeResponse>('POST', '/orders', body),
  modifyOrder: (ticket: number, body: ModifyOrderRequest) => request<TradeResponse>('PATCH', `/orders/${ticket}`, body),
  cancelOrder: (ticket: number) => request<TradeResponse>('DELETE', `/orders/${ticket}`),
  modifyPosition: (ticket: number, body: ModifyPositionRequest) =>
    request<TradeResponse>('PATCH', `/positions/${ticket}`, body),
  closePosition: (ticket: number, volume?: number) =>
    request<TradeResponse>('DELETE', `/positions/${ticket}${qs({ volume })}`),
  flatten: () => request<FlattenResponse>('POST', '/positions/flatten'),

  drawings: (symbol: string) =>
    request<{ symbol: string; drawings: Drawing[] }>('GET', `/drawings/${encodeURIComponent(symbol)}`),
  saveDrawings: (symbol: string, drawings: Drawing[]) =>
    request<{ symbol: string; drawings: Drawing[] }>('PUT', `/drawings/${encodeURIComponent(symbol)}`, { drawings }),

  riskSettings: () => request<RiskSettings>('GET', '/risk/settings'),
  saveRiskSettings: (body: RiskSettings) => request<RiskSettings>('PUT', '/risk/settings', body),
  news: () => request<NewsEvent[]>('GET', '/risk/news'),
  addNews: (time_utc: number, title: string) => request<NewsEvent>('POST', '/risk/news', { time_utc, title }),
  deleteNews: (id: number) => request<void>('DELETE', `/risk/news/${id}`),
  setJournalNote: (id: number, note: string) => request<JournalEntry>('PATCH', `/journal/${id}`, { note }),
  riskStatus: () => request<RiskStatus>('GET', '/risk/status'),
  riskCheck: (body: OrderCheckRequest) => request<RiskDecision>('POST', '/risk/check', body),
}
