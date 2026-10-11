import { useSyncExternalStore } from 'react'

export type ToastKind = 'info' | 'success' | 'error' | 'warn'
interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

export function toast(kind: ToastKind, text: string, ttlMs = kind === 'error' ? 8000 : 4000): void {
  const id = nextId++
  items = [...items.slice(-4), { id, kind, text }]
  emit()
  setTimeout(() => dismiss(id), ttlMs)
}

const STYLE: Record<ToastKind, string> = {
  info: 'border-accent/50',
  success: 'border-up/60',
  error: 'border-down/60',
  warn: 'border-warn/60',
}
const DOT: Record<ToastKind, string> = { info: 'bg-accent', success: 'bg-up', error: 'bg-down', warn: 'bg-warn' }

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => items,
  )
  return (
    <div className="pointer-events-none fixed bottom-4 left-64 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-md border bg-panel px-3 py-2 shadow-lg ${STYLE[t.kind]}`}
        >
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[t.kind]}`} />
          <span className="flex-1">{t.text}</span>
          <button type="button" className="text-muted hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
