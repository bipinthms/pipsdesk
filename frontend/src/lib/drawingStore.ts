// One copy of each symbol's drawings for the whole page, shared by every chart
// showing that symbol (whatever its timeframe — drawings store absolute times).
// An edit on one chart is pushed to the others and saved (debounced) once.
// With drawing sync off, each chart pane only shows (and edits) its own drawings.

import type { Drawing } from './drawings'

/** Does a chart pane show this drawing? Synced: all of them. Not synced: its own (and ones from before panes were recorded). */
export function visibleOn(d: Drawing, pane: string, sync: boolean): boolean {
  return sync || d.pane === undefined || d.pane === pane
}

/** Put a pane's edited drawings back into the symbol's full list. */
export function mergePane(all: Drawing[], shown: Drawing[], pane: string, sync: boolean): Drawing[] {
  return sync ? shown : [...all.filter((d) => !visibleOn(d, pane, sync)), ...shown]
}

export type DrawingListener = (drawings: Drawing[], source: unknown) => void

export interface DrawingBackend {
  load: (symbol: string) => Promise<Drawing[]>
  save: (symbol: string, drawings: Drawing[]) => Promise<unknown>
  onSaveError: (symbol: string, e: Error) => void
  onLoadError: (symbol: string, e: Error) => void
}

interface Entry {
  drawings: Drawing[]
  /** Saves replace the symbol's whole list, so nothing is saved until the load has finished. */
  status: 'loading' | 'ready' | 'error'
  dirty: boolean // edited while loading
  pending: boolean // saved edit not yet sent
  timer: ReturnType<typeof setTimeout> | undefined
  listeners: Set<DrawingListener>
}

export class DrawingStore {
  private entries = new Map<string, Entry>()

  constructor(
    private readonly backend: DrawingBackend,
    private readonly debounceMs = 600,
  ) {}

  get(symbol: string): Drawing[] {
    return this.entries.get(symbol)?.drawings ?? []
  }

  /**
   * Follow a symbol's drawings. The first subscriber loads them from the backend;
   * the last one to leave flushes unsaved edits and forgets them (so returning to
   * the symbol later reloads whatever is saved).
   */
  subscribe(symbol: string, listener: DrawingListener): () => void {
    let entry = this.entries.get(symbol)
    if (!entry) {
      const e: Entry = { drawings: [], status: 'loading', dirty: false, pending: false, timer: undefined, listeners: new Set() }
      this.entries.set(symbol, (entry = e))
      this.backend.load(symbol).then(
        (saved) => {
          if (this.entries.get(symbol) !== e) return
          // Drawings made while the load was in flight are merged, not overwritten.
          const ids = new Set(saved.map((d) => d.id))
          e.drawings = [...saved, ...e.drawings.filter((d) => !ids.has(d.id))]
          e.status = 'ready'
          this.notify(e, null)
          if (e.dirty) this.schedule(symbol, e)
        },
        (err: Error) => {
          if (this.entries.get(symbol) !== e) return
          // Keep edits local rather than risk overwriting what's saved.
          e.status = 'error'
          this.backend.onLoadError(symbol, err)
        },
      )
    }
    const e = entry
    e.listeners.add(listener)
    return () => {
      e.listeners.delete(listener)
      if (e.listeners.size || this.entries.get(symbol) !== e) return
      this.flushEntry(symbol, e)
      this.entries.delete(symbol)
    }
  }

  /** An edit from `source` (e.g. a chart's drawing layer): share it with the others and save. */
  set(symbol: string, drawings: Drawing[], source: unknown): void {
    const e = this.entries.get(symbol)
    if (!e) return
    e.drawings = drawings
    this.notify(e, source)
    if (e.status === 'ready') this.schedule(symbol, e)
    else if (e.status === 'loading') e.dirty = true
  }

  /** Send every unsaved edit now (page unload). */
  flush(): void {
    for (const [symbol, e] of this.entries) this.flushEntry(symbol, e)
  }

  private notify(e: Entry, source: unknown): void {
    for (const l of e.listeners) l(e.drawings, source)
  }

  private schedule(symbol: string, e: Entry): void {
    e.pending = true
    clearTimeout(e.timer)
    e.timer = setTimeout(() => this.flushEntry(symbol, e), this.debounceMs)
  }

  private flushEntry(symbol: string, e: Entry): void {
    clearTimeout(e.timer)
    if (!e.pending) return
    e.pending = false
    this.backend.save(symbol, e.drawings).catch((err: Error) => this.backend.onSaveError(symbol, err))
  }
}
