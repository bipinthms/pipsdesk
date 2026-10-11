// Drawing tools and the page-wide drawing preferences (magnet, keep drawing,
// sync, lock/hide all, each tool's default style), remembered in localStorage.

import { useSyncExternalStore } from 'react'
import { REMEMBERED, type DrawingStyle, type DrawingType } from './drawings'
import { load, save } from './storage'

export type ToolId = DrawingType | 'ray' | 'extended'
export type Tool = 'cursor' | ToolId

export interface ToolDef {
  id: ToolId
  type: DrawingType
  name: string
  /** Settings this tool always starts with (a ray is a trend line extended right). */
  preset?: DrawingStyle
  /** Alt+key shortcut. */
  key?: string
}

export const TOOL_GROUPS: { id: string; name: string; tools: ToolDef[] }[] = [
  {
    id: 'lines',
    name: 'Lines',
    tools: [
      { id: 'trend', type: 'trend', name: 'Trend line', key: 't' },
      { id: 'ray', type: 'trend', name: 'Ray', preset: { extendRight: true } },
      { id: 'extended', type: 'trend', name: 'Extended line', preset: { extendLeft: true, extendRight: true } },
      { id: 'arrow', type: 'arrow', name: 'Arrow' },
      { id: 'hline', type: 'hline', name: 'Horizontal line', key: 'h' },
      { id: 'hray', type: 'hray', name: 'Horizontal ray', key: 'j' },
      { id: 'vline', type: 'vline', name: 'Vertical line', key: 'v' },
      { id: 'cross', type: 'cross', name: 'Cross line', key: 'c' },
    ],
  },
  {
    id: 'fib',
    name: 'Channels & Fibonacci',
    tools: [
      { id: 'channel', type: 'channel', name: 'Parallel channel' },
      { id: 'fib', type: 'fib', name: 'Fib retracement', key: 'f' },
    ],
  },
  {
    id: 'shapes',
    name: 'Shapes',
    tools: [
      { id: 'rect', type: 'rect', name: 'Rectangle', key: 'r' },
      { id: 'ellipse', type: 'ellipse', name: 'Ellipse' },
      { id: 'triangle', type: 'triangle', name: 'Triangle' },
    ],
  },
  {
    id: 'annotate',
    name: 'Text & measure',
    tools: [
      { id: 'text', type: 'text', name: 'Text', key: 'x' },
      { id: 'range', type: 'range', name: 'Price range', key: 'm' },
      { id: 'long', type: 'long', name: 'Long position', key: 'l' },
      { id: 'short', type: 'short', name: 'Short position', key: 's' },
    ],
  },
]

export const TOOLS: Record<ToolId, ToolDef> = Object.fromEntries(
  TOOL_GROUPS.flatMap((g) => g.tools).map((t) => [t.id, t]),
) as Record<ToolId, ToolDef>

export type Magnet = 'off' | 'weak' | 'strong'

export interface DrawingPrefs {
  magnet: Magnet
  /** Stay on the drawing tool after finishing a drawing. */
  keepDrawing: boolean
  /** Charts of the same symbol share their drawings. Off: each chart keeps its own. */
  sync: boolean
  locked: boolean
  hidden: boolean
  /** Show the drawing toolbar in chart headers (hide it for more chart space). */
  toolbar: boolean
  /** Each type's remembered style, from the last time one was restyled. */
  styles: Partial<Record<DrawingType, DrawingStyle>>
  /** Last tool used in each toolbar group. */
  recent: Record<string, ToolId>
}

const KEY = 'pipdesk.drawingPrefs'
const DEFAULTS: DrawingPrefs = { magnet: 'off', keepDrawing: false, sync: true, locked: false, hidden: false, toolbar: true, styles: {}, recent: {} }

let prefs: DrawingPrefs = { ...DEFAULTS, ...load<Partial<DrawingPrefs>>(KEY, {}) }
const listeners = new Set<() => void>()

export const drawingPrefs = {
  get: (): DrawingPrefs => prefs,
  set(patch: Partial<DrawingPrefs>): void {
    prefs = { ...prefs, ...patch }
    save(KEY, prefs)
    for (const l of listeners) l()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Remember the parts of a restyle worth reusing as the type's default. */
  remember(type: DrawingType, style: DrawingStyle): void {
    const picked = Object.fromEntries(REMEMBERED.filter((k) => k in style).map((k) => [k, style[k]]))
    if (!Object.keys(picked).length) return
    drawingPrefs.set({ styles: { ...prefs.styles, [type]: { ...prefs.styles[type], ...picked } } })
  },
}

export function useDrawingPrefs(): DrawingPrefs {
  return useSyncExternalStore(drawingPrefs.subscribe, drawingPrefs.get)
}

/** The style a new drawing from `tool` starts with. */
export function initialStyle(tool: ToolId): DrawingStyle {
  const def = TOOLS[tool]
  return { ...prefs.styles[def.type], ...def.preset }
}
