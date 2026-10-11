import { useEffect, useRef, type RefObject } from 'react'
import { api } from '../api/client'
import { DrawingStore, mergePane, visibleOn } from '../lib/drawingStore'
import { fromLegacy, type Drawing } from '../lib/drawings'
import type { DrawingLayer } from './DrawingLayer'
import { toast } from './Toasts'

/** Shared by every chart on the page, so charts of the same symbol show the same drawings. */
const store = new DrawingStore({
  load: (symbol) => api.drawings(symbol).then((r) => r.drawings.map(fromLegacy).filter((d): d is Drawing => d !== null)),
  save: (symbol, drawings) => api.saveDrawings(symbol, drawings),
  onSaveError: (_, e) => toast('error', `Couldn't save drawings: ${e.message}`),
  onLoadError: (symbol, e) =>
    toast('warn', `Couldn't load drawings for ${symbol}: ${e.message}. Changes won't be saved until reload.`),
})
window.addEventListener('beforeunload', () => store.flush())

/**
 * Show the symbol's drawings on this chart's layer. With `sync` on, every chart of
 * the symbol (any timeframe) shows and edits the same drawings; with it off, each
 * chart pane only shows the drawings made on it. Edits are saved debounced.
 */
export function useDrawings(layer: RefObject<DrawingLayer | null>, symbol: string, pane: string, sync: boolean): void {
  const current = useRef({ symbol, pane, sync })
  current.current = { symbol, pane, sync }

  useEffect(() => {
    const l = layer.current
    if (!l) return
    l.onChange = (shown) => {
      const { symbol, pane, sync } = current.current
      store.set(symbol, mergePane(store.get(symbol), shown, pane, sync), l)
    }
  }, [layer])

  useEffect(() => {
    const l = layer.current
    if (!l) return
    const filter = (all: Drawing[]) => all.filter((d) => visibleOn(d, current.current.pane, current.current.sync))
    l.setDrawings(filter(store.get(symbol)))
    return store.subscribe(symbol, (drawings, source) => {
      if (source !== l) l.syncDrawings(filter(drawings))
    })
  }, [layer, symbol])

  // Sync switched (or the pane changed): re-filter without reloading.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const l = layer.current
    if (l) l.setDrawings(store.get(current.current.symbol).filter((d) => visibleOn(d, pane, sync)))
  }, [layer, pane, sync])
}
