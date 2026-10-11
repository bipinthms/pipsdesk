import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../api/client'
import { InFlight } from '../lib/inflight'
import { toast } from './Toasts'

export type Tone = 'buy' | 'sell' | 'danger' | 'neutral'

export interface ConfirmSpec {
  title: string
  tone: Tone
  rows?: [string, ReactNode][]
  warnings?: string[]
  /** Extra inputs rendered in the modal (e.g. partial close volume). */
  body?: ReactNode
  confirmLabel: string
  /** Runs the action. Throwing keeps the modal open and shows the error. */
  run: () => Promise<void>
  /** Always ask, even with one-click trading on (e.g. flatten all, chart drags). */
  always?: boolean
  /** Called when the dialog is dismissed without a successful run. */
  onCancel?: () => void
  /** Identifies the action for the double-submit guard in one-click mode (default: the title). */
  key?: string
}

interface ConfirmContextValue {
  confirm: (spec: ConfirmSpec) => Promise<void>
  oneClick: boolean
  setOneClick: (on: boolean) => void
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm outside ConfirmProvider')
  return ctx
}

const TONE: Record<Tone, string> = {
  buy: 'bg-up hover:brightness-110',
  sell: 'bg-down hover:brightness-110',
  danger: 'bg-down hover:brightness-110',
  neutral: 'bg-accent hover:brightness-110',
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const prefix =
      e.kind === 'risk' ? 'Blocked by risk rules: ' : e.kind === 'broker' ? 'Rejected: ' : e.kind === 'unknown' ? 'Unclear outcome: ' : ''
    return prefix + (e.violations.length > 1 ? e.violations.join(' ') : e.message)
  }
  return e instanceof Error ? e.message : String(e)
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  // One-click trading is deliberately not persisted: every session starts with confirmations on.
  const [oneClick, setOneClick] = useState(false)
  const [spec, setSpec] = useState<ConfirmSpec | null>(null)
  const inFlight = useRef(new InFlight())

  const confirm = useCallback(
    async (s: ConfirmSpec) => {
      if (oneClick && !s.always && !s.body) {
        // A double-click or key repeat must never send the same order twice.
        const sent = await inFlight.current.run(s.key ?? s.title, s.run).catch(() => true) // errors: the action's own toast
        if (!sent) toast('warn', 'Still sending the previous request. Wait for it to finish.')
        return
      }
      setSpec((prev) => {
        prev?.onCancel?.() // a new request replaces an unanswered one
        return s
      })
    },
    [oneClick],
  )

  return (
    <ConfirmContext.Provider value={{ confirm, oneClick, setOneClick }}>
      {children}
      {spec && <ConfirmModal spec={spec} onClose={() => setSpec(null)} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmModal({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Set synchronously, so a second click can't slip in before `busy` re-renders the button.
  const running = useRef(false)

  useEffect(() => {
    cancelRef.current?.focus() // safe default: Enter cancels, it never confirms by accident
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const cancel = () => {
    if (running.current) return
    spec.onCancel?.()
    onClose()
  }

  const go = async () => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    try {
      await spec.run()
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" onMouseDown={cancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-sm rounded-lg border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="border-b border-line px-4 py-3 text-[14px] font-semibold">
          {spec.title}
        </h2>
        <div className="flex flex-col gap-3 px-4 py-3">
          {spec.rows && spec.rows.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {spec.rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="num text-right">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {spec.body}
          {spec.warnings?.map((w) => (
            <p key={w} className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-warn">
              {w}
            </p>
          ))}
          {error && <p className="rounded border border-down/40 bg-down/10 px-2 py-1.5 text-down">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            disabled={busy}
            className="rounded border border-line px-3 py-1.5 text-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={go}
            disabled={busy}
            className={`rounded px-3 py-1.5 font-semibold text-white disabled:opacity-60 ${TONE[spec.tone]}`}
          >
            {busy ? 'Sending…' : spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
