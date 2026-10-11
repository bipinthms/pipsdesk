import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { defaultConfig, INDICATORS, indicatorLabel, sanitize, type IndicatorConfig, type IndicatorType } from '../lib/indicatorConfig'
import { newId } from '../lib/drawings'
import { drawingPrefs, TOOL_GROUPS, TOOLS, useDrawingPrefs, type Magnet, type Tool, type ToolId } from '../lib/drawingPrefs'

// --- shared bits ----------------------------------------------------------------

export const icon = (path: ReactNode) => (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    {path}
  </svg>
)

/** Close a popover on an outside press or Escape. */
export function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
}

const BTN = 'grid h-6 w-7 place-items-center rounded text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30'
const MENU = 'absolute top-7 left-0 z-30 min-w-48 rounded-md border border-line bg-panel p-1 shadow-xl'
const ITEM = 'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-panel-2'
const chevron = <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4.5 6.5 L8 10 L11.5 6.5" /></svg>
const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r="1.3" />

// --- drawing tools -------------------------------------------------------------

export const TOOL_ICONS: Record<Tool, ReactNode> = {
  cursor: icon(<path d="M4 2 L4 13 L7 10 L9 14 L11 13 L9 9 L13 9 Z" />),
  trend: icon(<><path d="M2 13 L14 3" />{dot(2.5, 12.5)}{dot(13.5, 3.5)}</>),
  ray: icon(<><path d="M2.5 12.5 L15 2" />{dot(2.5, 12.5)}{dot(9, 7.2)}</>),
  extended: icon(<><path d="M1 14.5 L15 1.5" />{dot(5, 10.8)}{dot(11, 5.2)}</>),
  arrow: icon(<path d="M2.5 13.5 L13 3 M7.5 3 H13 V8.5" />),
  hline: icon(<path d="M1 8 H15" />),
  hray: icon(<><path d="M4 8 H15" />{dot(3, 8)}</>),
  vline: icon(<path d="M8 1 V15" />),
  cross: icon(<path d="M8 1 V15 M1 8 H15" />),
  channel: icon(<path d="M1 10 L11 2.5 M5 14 L15 6.5" />),
  fib: icon(<path d="M1 2.5 H15 M1 6 H15 M1 9.5 H15 M1 13.5 H15 M3 13.5 L13 2.5" strokeDasharray="0" />),
  rect: icon(<rect x="2.5" y="4" width="11" height="8" />),
  ellipse: icon(<ellipse cx="8" cy="8" rx="6.5" ry="4.5" />),
  triangle: icon(<path d="M8 2.5 L14 13.5 H2 Z" />),
  text: icon(<path d="M3 3.5 H13 M8 3.5 V13.5 M6 13.5 H10" />),
  range: icon(<path d="M2 2 H14 M2 14 H14 M8 3 V13 M5.5 5.5 L8 3 L10.5 5.5 M5.5 10.5 L8 13 L10.5 10.5" />),
  long: icon(<><rect x="2" y="2.5" width="12" height="11" /><path d="M2 9 H14 M5.5 6.5 L8 4 L10.5 6.5" /></>),
  short: icon(<><rect x="2" y="2.5" width="12" height="11" /><path d="M2 7 H14 M5.5 9.5 L8 12 L10.5 9.5" /></>),
}

export const ICONS = {
  magnet: icon(<path d="M3.5 2 V8 a4.5 4.5 0 0 0 9 0 V2 H10 V8 a2 2 0 0 1 -4 0 V2 Z M3.5 4.5 H6 M10 4.5 H12.5" />),
  keep: icon(<><path d="M10.5 2.5 L13.5 5.5 L6 13 L2.5 13.5 L3 10 Z" /><path d="M9 4 L12 7" /></>),
  sync: icon(<path d="M6.5 9.5 L9.5 6.5 M7 5 L8.7 3.3 a2.6 2.6 0 0 1 3.7 3.7 L10.7 8.7 M9 11 L7.3 12.7 a2.6 2.6 0 0 1 -3.7 -3.7 L5.3 7.3" />),
  lock: icon(<><rect x="3.5" y="7" width="9" height="7" rx="1" /><path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7" /></>),
  unlock: icon(<><rect x="3.5" y="7" width="9" height="7" rx="1" /><path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0" /></>),
  eye: icon(<><path d="M1.5 8 C3.5 4 12.5 4 14.5 8 C12.5 12 3.5 12 1.5 8 Z" /><circle cx="8" cy="8" r="2" /></>),
  eyeOff: icon(<path d="M1.5 8 C3.5 4 12.5 4 14.5 8 C12.5 12 3.5 12 1.5 8 Z M2.5 13.5 L13.5 2.5" />),
  trash: icon(<path d="M3 4 H13 M6 4 V2.5 H10 V4 M4.5 4 L5.5 14 H10.5 L11.5 4" />),
  clone: icon(<><rect x="5" y="5" width="9" height="9" rx="1" /><path d="M11 5 V2.5 H2.5 V11 H5" /></>),
  gear: icon(<><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5 V3.5 M8 12.5 V14.5 M1.5 8 H3.5 M12.5 8 H14.5 M3.4 3.4 L4.8 4.8 M11.2 11.2 L12.6 12.6 M3.4 12.6 L4.8 11.2 M11.2 4.8 L12.6 3.4" /></>),
  collapse: icon(<path d="M9.5 3.5 L5 8 L9.5 12.5 M13 3.5 V12.5" />),
  more: icon(<path d="M3.5 8 h0.01 M8 8 h0.01 M12.5 8 h0.01" strokeWidth="2.4" strokeLinecap="round" />),
}

const MAGNET_MODES: [Magnet, string, string][] = [
  ['off', 'Magnet off', 'Points go exactly where you click'],
  ['weak', 'Weak magnet', 'Snaps to a bar’s open/high/low/close when close to it'],
  ['strong', 'Strong magnet', 'Always snaps to the nearest open/high/low/close'],
]

/** A tool group: the button picks the group's last-used tool, the arrow lists them all. */
function ToolGroup({ group, tool, onTool }: { group: (typeof TOOL_GROUPS)[number]; tool: Tool; onTool: (t: Tool) => void }) {
  const prefs = useDrawingPrefs()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const inGroup = group.tools.some((t) => t.id === tool)
  const current = inGroup ? (tool as ToolId) : (prefs.recent[group.id] ?? group.tools[0]!.id)
  const pick = (id: ToolId) => {
    drawingPrefs.set({ recent: { ...prefs.recent, [group.id]: id } })
    onTool(id)
    setOpen(false)
  }
  const def = TOOLS[current]
  return (
    <div ref={ref} className="relative flex">
      <button type="button" title={`${def.name}${def.key ? ` (Alt+${def.key.toUpperCase()})` : ''}`} aria-label={def.name} aria-pressed={inGroup}
        onClick={() => (inGroup ? onTool('cursor') : pick(current))}
        className={`${BTN} rounded-r-none ${inGroup ? 'bg-panel-2 text-accent' : ''}`}>
        {TOOL_ICONS[current]}
      </button>
      <button type="button" title={`More ${group.name.toLowerCase()}`} aria-label={`${group.name} tools`} aria-expanded={open} onClick={() => setOpen(!open)}
        className={`${BTN} w-3.5 rounded-l-none ${open ? 'bg-panel-2 text-fg' : ''}`}>
        {chevron}
      </button>
      {open && (
        <div className={MENU} role="menu">
          <div className="px-2 py-1 text-[10px] tracking-wide text-muted uppercase">{group.name}</div>
          {group.tools.map((t) => (
            <button key={t.id} type="button" role="menuitem" onClick={() => pick(t.id)}
              className={`${ITEM} ${t.id === tool ? 'text-accent' : ''}`}>
              {TOOL_ICONS[t.id]}
              <span className="flex-1">{t.name}</span>
              {t.key && <span className="text-[10px] text-muted">Alt+{t.key.toUpperCase()}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MagnetButton() {
  const { magnet } = useDrawingPrefs()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const on = magnet !== 'off'
  const label = MAGNET_MODES.find(([m]) => m === magnet)![1]
  return (
    <div ref={ref} className="relative flex">
      <button type="button" title={`${label} (hold Ctrl/⌘ to flip while drawing)`} aria-label="Magnet" aria-pressed={on}
        onClick={() => drawingPrefs.set({ magnet: on ? 'off' : 'weak' })}
        className={`${BTN} rounded-r-none ${on ? 'bg-panel-2 text-accent' : ''}`}>
        {ICONS.magnet}
        {magnet === 'strong' && <span className="sr-only">strong</span>}
      </button>
      <button type="button" title="Magnet mode" aria-label="Magnet mode" aria-expanded={open} onClick={() => setOpen(!open)}
        className={`${BTN} w-3.5 rounded-l-none ${open ? 'bg-panel-2 text-fg' : ''}`}>
        {chevron}
      </button>
      {open && (
        <div className={`${MENU} w-64`} role="menu">
          {MAGNET_MODES.map(([m, name, hint]) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={magnet === m}
              onClick={() => { drawingPrefs.set({ magnet: m }); setOpen(false) }}
              className={`${ITEM} items-start`}>
              <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full border ${magnet === m ? 'border-accent bg-accent' : 'border-muted'}`} />
              <span className="flex flex-col">
                <span className={magnet === m ? 'text-accent' : ''}>{name}</span>
                <span className="text-[11px] text-muted">{hint}</span>
              </span>
            </button>
          ))}
          <p className="px-2 pt-1 pb-0.5 text-[11px] text-muted">Hold Ctrl/⌘ while drawing to flip it. Hold Shift to keep lines level.</p>
        </div>
      )}
    </div>
  )
}

function Toggle({ on, title, children, onClick }: { on: boolean; title: string; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={on} onClick={onClick}
      className={`${BTN} ${on ? 'bg-panel-2 text-accent' : ''}`}>
      {children}
    </button>
  )
}

function MoreMenu({ count, onClear }: { count: number; onClear: () => void }) {
  const prefs = useDrawingPrefs()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const check = (on: boolean) => (
    <span className={`grid h-3.5 w-3.5 place-items-center rounded-sm border text-[9px] ${on ? 'border-accent bg-accent text-white' : 'border-muted'}`}>{on ? '✓' : ''}</span>
  )
  return (
    <div ref={ref} className="relative">
      <button type="button" title="Drawing options" aria-label="Drawing options" aria-expanded={open} onClick={() => setOpen(!open)}
        className={`${BTN} ${open ? 'bg-panel-2 text-fg' : ''}`}>
        {ICONS.more}
      </button>
      {open && (
        <div className={`${MENU.replace('left-0', 'right-0')} w-64`} role="menu">
          <button type="button" role="menuitemcheckbox" aria-checked={prefs.sync} className={ITEM} onClick={() => drawingPrefs.set({ sync: !prefs.sync })}>
            {check(prefs.sync)}
            <span className="flex flex-col">
              <span>Sync drawings across charts</span>
              <span className="text-[11px] text-muted">{prefs.sync ? 'Every chart of a symbol shows the same drawings' : 'Each chart keeps its own drawings'}</span>
            </span>
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={prefs.keepDrawing} className={ITEM} onClick={() => drawingPrefs.set({ keepDrawing: !prefs.keepDrawing })}>
            {check(prefs.keepDrawing)} Keep drawing after a drawing is finished
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={prefs.locked} className={ITEM} onClick={() => drawingPrefs.set({ locked: !prefs.locked })}>
            {check(prefs.locked)} Lock all drawings
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={prefs.hidden} className={ITEM} onClick={() => drawingPrefs.set({ hidden: !prefs.hidden })}>
            {check(prefs.hidden)} Hide all drawings
          </button>
          <div className="my-1 h-px bg-line" />
          <button type="button" role="menuitem" disabled={!count} className={`${ITEM} text-down disabled:opacity-40`}
            onClick={() => { setOpen(false); onClear() }}>
            {ICONS.trash} Remove {count ? `${count} ` : ''}drawing{count === 1 ? '' : 's'} on this chart…
          </button>
        </div>
      )}
    </div>
  )
}

interface DrawingToolsProps {
  tool: Tool
  onTool: (t: Tool) => void
  hasSelection: boolean
  /** Drawings shown on this chart. */
  count: number
  onDelete: () => void
  onClear: () => void
}

/** The drawing toolbar; in narrow charts (many-chart layouts) it folds into one button. */
export function DrawingTools(props: DrawingToolsProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const { toolbar } = useDrawingPrefs()
  const active = props.tool !== 'cursor'
  if (!toolbar) {
    return (
      <button type="button" title="Show drawing tools" aria-label="Show drawing tools" onClick={() => drawingPrefs.set({ toolbar: true })}
        className={`${BTN} ${active ? 'bg-panel-2 text-accent' : ''}`}>
        {active ? TOOL_ICONS[props.tool] : ICONS.keep}
      </button>
    )
  }
  return (
    <>
      <div className="hidden @xl:block"><ToolBar {...props} /></div>
      <div ref={ref} className="relative @xl:hidden">
        <button type="button" title="Drawing tools" aria-label="Drawing tools" aria-expanded={open} onClick={() => setOpen(!open)}
          className={`flex h-6 items-center gap-0.5 rounded px-1 text-muted hover:bg-panel-2 hover:text-fg ${open || active ? 'bg-panel-2 text-accent' : ''}`}>
          {active ? TOOL_ICONS[props.tool] : ICONS.keep}
          {chevron}
        </button>
        {open && (
          <div className={`${MENU} w-60 p-1.5`}>
            <ToolBar {...props} onTool={(t) => { props.onTool(t); setOpen(false) }} />
          </div>
        )}
      </div>
    </>
  )
}

function ToolBar({ tool, onTool, hasSelection, count, onDelete, onClear }: DrawingToolsProps) {
  const prefs = useDrawingPrefs()
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="Drawing tools">
      <Toggle on={tool === 'cursor'} title="Select / move (Esc)" onClick={() => onTool('cursor')}>{TOOL_ICONS.cursor}</Toggle>
      {TOOL_GROUPS.map((g) => <ToolGroup key={g.id} group={g} tool={tool} onTool={onTool} />)}
      <span className="mx-0.5 h-4 w-px bg-line" />
      <MagnetButton />
      {/* Narrow charts: these two stay reachable in the ⋯ menu. */}
      <span className="hidden items-center gap-0.5 @2xl:flex">
      <Toggle on={prefs.keepDrawing} title={`Keep drawing: ${prefs.keepDrawing ? 'on' : 'off'} (stay on the tool after each drawing)`}
        onClick={() => drawingPrefs.set({ keepDrawing: !prefs.keepDrawing })}>{ICONS.keep}</Toggle>
      <Toggle on={prefs.sync} title={`Sync drawings across charts: ${prefs.sync ? 'on' : 'off'}`}
        onClick={() => drawingPrefs.set({ sync: !prefs.sync })}>{ICONS.sync}</Toggle>
      </span>
      {prefs.locked && <Toggle on title="Drawings are locked: unlock" onClick={() => drawingPrefs.set({ locked: false })}>{ICONS.lock}</Toggle>}
      {prefs.hidden && <Toggle on title="Drawings are hidden: show them" onClick={() => drawingPrefs.set({ hidden: false })}>{ICONS.eyeOff}</Toggle>}
      <button type="button" className={BTN} title="Delete selected drawing (Del)" aria-label="Delete selected drawing" disabled={!hasSelection} onClick={onDelete}>
        {ICONS.trash}
      </button>
      <MoreMenu count={count} onClear={onClear} />
      <button type="button" className={BTN} title="Hide drawing tools on all charts (more room for the chart)" aria-label="Hide drawing tools"
        onClick={() => { onTool('cursor'); drawingPrefs.set({ toolbar: false }) }}>
        {ICONS.collapse}
      </button>
    </div>
  )
}

// --- indicators menu ----------------------------------------------------------------

export function IndicatorMenu({ configs, onChange }: { configs: IndicatorConfig[]; onChange: (c: IndicatorConfig[]) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useDismiss(open, () => setOpen(false), ref)

  const update = (id: string, patch: Partial<IndicatorConfig>) =>
    onChange(configs.map((c) => (c.id === id ? sanitize({ ...c, ...patch }) : c)))

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className={`rounded px-2 py-0.5 text-[12px] ${open ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg'}`}>
        Indicators{configs.length ? ` (${configs.length})` : ''}
      </button>
      {open && (
        <div className="absolute top-8 left-0 z-30 w-80 rounded-md border border-line bg-panel p-2 shadow-xl">
          <div className="mb-2 flex flex-wrap gap-1">
            {(Object.keys(INDICATORS) as IndicatorType[]).map((t) => (
              <button key={t} type="button" onClick={() => onChange([...configs, defaultConfig(t, newId())])}
                className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg">
                + {INDICATORS[t].name}
              </button>
            ))}
          </div>
          {configs.length === 0 && <p className="px-1 py-2 text-[12px] text-muted">No indicators. Add one above.</p>}
          <ul className="flex flex-col gap-1">
            {configs.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded bg-panel-2 px-2 py-1">
                <input type="color" value={c.color} onChange={(e) => update(c.id, { color: e.target.value })}
                  className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0" aria-label={`${indicatorLabel(c)} colour`} />
                <span className="w-12 text-[12px] font-medium">{c.type === 'bb' ? 'BB' : INDICATORS[c.type].name}</span>
                {INDICATORS[c.type].params.map((p, i) => (
                  <label key={p.label} className="flex items-center gap-1 text-[10px] text-muted" title={p.label}>
                    {p.label.slice(0, 6)}
                    <input type="number" min={p.min} max={p.max} step={p.step ?? 1} value={c.params[i]}
                      onChange={(e) => update(c.id, { params: c.params.map((v, j) => (j === i ? Number(e.target.value) : v)) })}
                      className="num w-12 rounded border border-line bg-panel px-1 py-0.5 text-right text-[11px] text-fg" />
                  </label>
                ))}
                <button type="button" onClick={() => onChange(configs.filter((x) => x.id !== c.id))}
                  className="ml-auto text-muted hover:text-down" aria-label={`Remove ${indicatorLabel(c)}`}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// --- chart layout -----------------------------------------------------------------

/** [column, row, column span, row span], zero-based. */
type Cell = [number, number, number, number]

interface LayoutDef {
  title: string
  cols: number
  rows: number
  cells: Cell[]
}

function uniform(cols: number, rows: number): Pick<LayoutDef, 'cols' | 'rows' | 'cells'> {
  const cells: Cell[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([c, r, 1, 1])
  return { cols, rows, cells }
}

export const LAYOUTS = {
  '1': { title: 'Single chart', ...uniform(1, 1) },
  '2v': { title: 'Two side by side', ...uniform(2, 1) },
  '2h': { title: 'Two stacked', ...uniform(1, 2) },
  '3': { title: 'Three: large left', cols: 2, rows: 2, cells: [[0, 0, 1, 2], [1, 0, 1, 1], [1, 1, 1, 1]] },
  '3t': { title: 'Three: large top', cols: 2, rows: 2, cells: [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
  '3v': { title: 'Three columns', ...uniform(3, 1) },
  '3h': { title: 'Three rows', ...uniform(1, 3) },
  '4': { title: 'Four: 2 × 2', ...uniform(2, 2) },
  '4l': { title: 'Four: large left', cols: 2, rows: 3, cells: [[0, 0, 1, 3], [1, 0, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]] },
  '4v': { title: 'Four columns', ...uniform(4, 1) },
  '4h': { title: 'Four rows', ...uniform(1, 4) },
  '6': { title: 'Six: 3 × 2', ...uniform(3, 2) },
  '8': { title: 'Eight: 4 × 2', ...uniform(4, 2) },
} satisfies Record<string, LayoutDef>

export type Layout = keyof typeof LAYOUTS

export const MAX_PANES = 8

export function isLayout(l: unknown): l is Layout {
  return typeof l === 'string' && l in LAYOUTS
}

export function paneCount(l: Layout): number {
  return LAYOUTS[l].cells.length
}

export function layoutGrid(l: Layout): CSSProperties {
  const { cols, rows } = LAYOUTS[l]
  return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }
}

export function layoutCell(l: Layout, i: number): CSSProperties {
  const [c, r, w, h] = LAYOUTS[l].cells[i]!
  return { gridColumn: `${c + 1} / span ${w}`, gridRow: `${r + 1} / span ${h}` }
}

function LayoutIcon({ layout }: { layout: Layout }) {
  const { cols, rows, cells } = LAYOUTS[layout]
  const W = 12
  const H = 11
  return icon(
    <>
      {(cells as Cell[]).map(([c, r, w, h], i) => (
        <rect key={i} x={2 + (c * W) / cols} y={2.5 + (r * H) / rows} width={(w * W) / cols} height={(h * H) / rows} />
      ))}
    </>,
  )
}

export function LayoutPicker({ layout, onChange }: { layout: Layout; onChange: (l: Layout) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const byCount = new Map<number, Layout[]>()
  for (const l of Object.keys(LAYOUTS) as Layout[]) byCount.set(paneCount(l), [...(byCount.get(paneCount(l)) ?? []), l])
  return (
    <div ref={ref} className="relative">
      <button type="button" title={`Layout: ${LAYOUTS[layout].title}`} aria-label="Chart layout" aria-expanded={open} onClick={() => setOpen(!open)}
        className={`flex h-6 items-center gap-0.5 rounded px-1 text-muted hover:bg-panel-2 hover:text-fg ${open ? 'bg-panel-2 text-fg' : ''}`}>
        <LayoutIcon layout={layout} />
        {chevron}
      </button>
      {open && (
        <div className={`${MENU} w-auto p-2`} role="menu" aria-label="Chart layouts">
          {[...byCount].map(([n, ls]) => (
            <div key={n} className="flex items-center gap-1 py-0.5">
              <span className="num w-4 text-[11px] text-muted">{n}</span>
              {ls.map((l) => (
                <button key={l} type="button" role="menuitemradio" aria-checked={l === layout} title={LAYOUTS[l].title} aria-label={LAYOUTS[l].title}
                  onClick={() => { onChange(l); setOpen(false) }}
                  className={`${BTN} h-7 w-8 ${l === layout ? 'bg-panel-2 text-accent' : ''}`}>
                  <LayoutIcon layout={l} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
