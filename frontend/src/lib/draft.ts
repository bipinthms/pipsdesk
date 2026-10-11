import { useSyncExternalStore } from 'react'
import type { Draft } from './tradeLines'

// The order being composed in the order panel, shared with the chart. The panel
// publishes it; the chart draws it and sends back edits when a line is dragged.

let current: Draft | null = null
const listeners = new Set<() => void>()

function same(a: Draft | null, b: Draft | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k])
}

export function setDraft(d: Draft | null): void {
  if (same(d, current)) return
  current = d
  listeners.forEach((l) => l())
}

export function useDraft(): Draft | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  )
}

export interface DraftEdit {
  field: 'entry' | 'sl' | 'tp'
  price: number
}

const editListeners = new Set<(e: DraftEdit) => void>()

/** Chart → order panel: a draft line was dragged to a new price. */
export function editDraft(e: DraftEdit): void {
  editListeners.forEach((l) => l(e))
}

export function onDraftEdit(fn: (e: DraftEdit) => void): () => void {
  editListeners.add(fn)
  return () => editListeners.delete(fn)
}
