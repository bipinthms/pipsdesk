import { useSyncExternalStore } from 'react'
import type { AccountInfo, ClientMessage, Health, PendingOrder, Position, RiskStatus, StreamMessage, Tick, Timeframe } from './types'

export type ConnectionState = 'connecting' | 'open' | 'closed'
type MessageOf<K extends StreamMessage['type']> = Extract<StreamMessage, { type: K }>

const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 10_000

/**
 * One WebSocket to the backend, reconnecting with backoff. Holds the desired
 * subscriptions and re-sends them after every reconnect, and caches the latest
 * status/account/positions/ticks so late-mounting components render immediately.
 */
export class StreamClient {
  private ws: WebSocket | undefined
  private handlers = new Map<string, Set<(m: StreamMessage) => void>>()
  private listeners = new Set<() => void>()
  private retryMs = MIN_RETRY_MS
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private symbols: string[] = []
  private charts = new Map<string, { symbol: string; timeframe: Timeframe }>() // by chart id

  state: ConnectionState = 'connecting'
  status: Health | undefined
  account: AccountInfo | undefined
  risk: RiskStatus | undefined
  positions: Position[] = []
  orders: PendingOrder[] = []
  ticks: Record<string, Tick> = {}

  constructor(private readonly url: string) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.connect()
  }

  stop(): void {
    this.started = false
    clearTimeout(this.timer)
    this.ws?.close()
  }

  setSymbols(symbols: string[]): void {
    this.symbols = [...new Set(symbols)].sort()
    this.send({ type: 'subscribe', symbols: this.symbols })
  }

  /** Stream the forming candle for chart `id` (several charts can be open); symbol=null stops it. */
  setChart(id: string, symbol: string | null, timeframe: Timeframe): void {
    if (symbol) this.charts.set(id, { symbol, timeframe })
    else this.charts.delete(id)
    this.sendCharts()
  }

  private sendCharts(): void {
    const unique = new Map([...this.charts.values()].map((c) => [`${c.symbol}:${c.timeframe}`, c]))
    this.send({ type: 'charts', charts: [...unique.values()] })
  }

  on<K extends StreamMessage['type']>(type: K, handler: (m: MessageOf<K>) => void): () => void {
    let set = this.handlers.get(type)
    if (!set) this.handlers.set(type, (set = new Set()))
    const h = handler as (m: StreamMessage) => void
    set.add(h)
    return () => set.delete(h)
  }

  /** For useSyncExternalStore: fires whenever cached state changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.notify()
  }

  private connect(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.retryMs = MIN_RETRY_MS
      this.setState('open')
      this.send({ type: 'subscribe', symbols: this.symbols })
      this.sendCharts()
    }
    ws.onmessage = (ev) => {
      let msg: StreamMessage
      try {
        msg = JSON.parse(String(ev.data)) as StreamMessage
      } catch {
        return
      }
      this.cache(msg)
      for (const h of this.handlers.get(msg.type) ?? []) h(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.setState('closed')
      if (!this.started) return
      this.timer = setTimeout(() => this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
    }
  }

  private cache(msg: StreamMessage): void {
    switch (msg.type) {
      case 'status':
        this.status = msg.status
        break
      case 'account':
        this.account = msg.account
        break
      case 'risk':
        this.risk = msg.risk
        break
      case 'positions':
        this.positions = msg.positions
        break
      case 'orders':
        this.orders = msg.orders
        break
      case 'tick':
        this.ticks = { ...this.ticks, [msg.tick.symbol]: msg.tick }
        break
      default:
        return
    }
    this.notify()
  }
}

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/stream`
export const stream = new StreamClient(wsUrl)

/** Subscribe a component to a slice of the stream's cached state. */
export function useStream<T>(select: (s: StreamClient) => T): T {
  return useSyncExternalStore(stream.subscribe, () => select(stream))
}
