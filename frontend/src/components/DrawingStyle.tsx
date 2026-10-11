import { useEffect, useRef, useState } from 'react'
import {
  CAPS,
  FIB_CHOICES,
  styleOf,
  TYPE_NAMES,
  type Dash,
  type Drawing,
  type DrawingStyle,
  type DrawingType,
} from '../lib/drawings'
import { ICONS, useDismiss } from './ChartTools'

const PALETTE = [
  '#2f6fed', '#4d86ff', '#00bcd4', '#12a37a', '#8bc34a', '#f0a628',
  '#ff7a1a', '#e0464e', '#e91e63', '#9c27b0', '#787b86', '#ffffff',
]

const DASHES: [Dash, string][] = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]

const LABEL_NAMES: Partial<Record<DrawingType, string>> = {
  fib: 'Show level prices',
  trend: 'Show price change',
  range: 'Show stats',
  long: 'Show prices, pips and R:R',
  short: 'Show prices, pips and R:R',
}

const POINT_NAMES: Partial<Record<DrawingType, string[]>> = {
  long: ['Entry', 'Stop', 'Target'],
  short: ['Entry', 'Stop', 'Target'],
  channel: ['Point 1', 'Point 2', 'Width'],
  fib: ['Start (level 1)', 'End (level 0)'],
}

function pointNames(d: Drawing): string[] {
  return POINT_NAMES[d.type] ?? (d.points.length === 1 ? ['Price'] : d.points.map((_, i) => `Point ${i + 1}`))
}

const BAR_BTN = 'grid h-7 w-7 place-items-center rounded text-muted hover:bg-panel-2 hover:text-fg'
const SELECT = 'h-7 rounded border border-line bg-panel px-1 text-[12px] text-fg'

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  return (
    <div ref={ref} className="relative">
      <button type="button" title="Colour" aria-label="Colour" aria-expanded={open} onClick={() => setOpen(!open)} className={BAR_BTN}>
        <span className="h-4 w-4 rounded-sm border border-line" style={{ background: value }} />
      </button>
      {open && (
        <div className="absolute top-8 left-0 z-30 w-44 rounded-md border border-line bg-panel p-2 shadow-xl">
          <div className="grid grid-cols-6 gap-1">
            {PALETTE.map((c) => (
              <button key={c} type="button" title={c} aria-label={c} onClick={() => { onChange(c); setOpen(false) }}
                className={`h-5 w-5 rounded-sm border ${c.toLowerCase() === value.toLowerCase() ? 'border-fg' : 'border-line'}`} style={{ background: c }} />
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-[11px] text-muted">
            Custom
            <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0" />
          </label>
        </div>
      )}
    </div>
  )
}

/**
 * Floating bar over the chart for the selected drawing: colour, width, line
 * style, text, settings, lock, clone and delete. Changes apply straight away
 * and become the default for new drawings of that type.
 */
export function DrawingStyleBar({ drawing, accent, focusText, onChange, onClone, onDelete, onSettings }: {
  drawing: Drawing
  accent: string
  /** Put the cursor in the text box (a text drawing was just placed). */
  focusText: boolean
  onChange: (patch: Partial<Drawing>) => void
  onClone: () => void
  onDelete: () => void
  onSettings: () => void
}) {
  const s = styleOf(drawing, accent)
  const textRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusText) textRef.current?.select()
  }, [focusText, drawing.id])
  const locked = !!drawing.locked

  return (
    <div className="absolute top-2 left-1/2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-1 shadow-lg"
      role="toolbar" aria-label={`${TYPE_NAMES[drawing.type]} settings`} onPointerDown={(e) => e.stopPropagation()}>
      <span className="hidden px-1 text-[11px] whitespace-nowrap text-muted @xl:inline">{TYPE_NAMES[drawing.type]}</span>
      <ColorPicker value={s.color} onChange={(color) => onChange({ color })} />
      <select className={SELECT} title="Line width" aria-label="Line width" value={s.width} onChange={(e) => onChange({ width: Number(e.target.value) })}>
        {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
      </select>
      <select className={`${SELECT} hidden @lg:block`} title="Line style" aria-label="Line style" value={s.dash} onChange={(e) => onChange({ dash: e.target.value as Dash })}>
        {DASHES.map(([d, name]) => <option key={d} value={d}>{name}</option>)}
      </select>
      {CAPS[drawing.type].text && (
        <input ref={textRef} className="h-7 w-32 rounded border border-line bg-panel px-1.5 text-[12px]" aria-label="Text" value={drawing.text ?? s.text}
          onChange={(e) => onChange({ text: e.target.value })} />
      )}
      <span className="mx-0.5 h-4 w-px bg-line" />
      <button type="button" className={BAR_BTN} title="Settings" aria-label="Drawing settings" onClick={onSettings}>{ICONS.gear}</button>
      <button type="button" className={`${BAR_BTN} ${locked ? 'text-accent' : ''}`} title={locked ? 'Unlock' : 'Lock (stop it moving)'} aria-pressed={locked}
        aria-label="Lock drawing" onClick={() => onChange({ locked: !locked || undefined })}>
        {locked ? ICONS.lock : ICONS.unlock}
      </button>
      <button type="button" className={BAR_BTN} title="Clone" aria-label="Clone drawing" onClick={onClone}>{ICONS.clone}</button>
      <button type="button" className={`${BAR_BTN} hover:text-down`} title="Delete (Del)" aria-label="Delete drawing" onClick={onDelete}>{ICONS.trash}</button>
    </div>
  )
}

/** Every setting of the selected drawing, including exact prices. Edits apply live. */
export function DrawingSettings({ drawing, accent, digits, step, onChange, onClose }: {
  drawing: Drawing
  accent: string
  digits: number
  step: number
  onChange: (patch: Partial<Drawing>) => void
  onClose: () => void
}) {
  const s = styleOf(drawing, accent)
  const caps = CAPS[drawing.type]
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const row = 'grid grid-cols-[7rem_1fr] items-center gap-2'
  const check = (label: string, value: boolean, patch: (v: boolean) => Partial<DrawingStyle>) => (
    <label className="flex items-center gap-2 text-[12px]">
      <input type="checkbox" checked={value} onChange={(e) => onChange(patch(e.target.checked))} className="accent-accent" />
      {label}
    </label>
  )
  const setPrice = (i: number, raw: string) => {
    const price = Number(raw)
    if (raw === '' || !Number.isFinite(price)) return
    onChange({ points: drawing.points.map((p, j) => (j === i ? { ...p, price } : p)) })
  }
  const showPrices = drawing.type !== 'vline'
  const names = pointNames(drawing)

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="drawing-settings-title"
        className="flex max-h-full w-full max-w-sm flex-col rounded-lg border border-line bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="drawing-settings-title" className="border-b border-line px-4 py-3 text-[14px] font-semibold">{TYPE_NAMES[drawing.type]}</h2>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3">
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] tracking-wide text-muted uppercase">Style</h3>
            <div className={row}>
              <span className="text-muted">Colour</span>
              <div className="flex flex-wrap items-center gap-1">
                {['#2f6fed', '#12a37a', '#e0464e', '#f0a628', '#9c27b0', '#787b86'].map((c) => (
                  <button key={c} type="button" aria-label={c} onClick={() => onChange({ color: c })} style={{ background: c }}
                    className={`h-5 w-5 rounded-sm border ${c === s.color.toLowerCase() ? 'border-fg' : 'border-line'}`} />
                ))}
                <input type="color" aria-label="Custom colour" value={s.color} onChange={(e) => onChange({ color: e.target.value })} className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0" />
              </div>
            </div>
            <div className={row}>
              <span className="text-muted">Line</span>
              <div className="flex gap-2">
                <select className={SELECT} aria-label="Line width" value={s.width} onChange={(e) => onChange({ width: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
                </select>
                <select className={SELECT} aria-label="Line style" value={s.dash} onChange={(e) => onChange({ dash: e.target.value as Dash })}>
                  {DASHES.map(([d, name]) => <option key={d} value={d}>{name}</option>)}
                </select>
              </div>
            </div>
            {caps.fill && (
              <label className={row}>
                <span className="text-muted">Fill</span>
                <span className="flex items-center gap-2">
                  <input type="range" min={0} max={60} value={Math.round(s.fill * 100)} onChange={(e) => onChange({ fill: Number(e.target.value) / 100 })} className="flex-1 accent-accent" />
                  <span className="num w-9 text-right text-[12px]">{Math.round(s.fill * 100)}%</span>
                </span>
              </label>
            )}
            {caps.extend && (
              <div className={row}>
                <span className="text-muted">Extend</span>
                <div className="flex gap-4">
                  {check('Left', s.extendLeft, (v) => ({ extendLeft: v }))}
                  {check('Right', s.extendRight, (v) => ({ extendRight: v }))}
                </div>
              </div>
            )}
            {caps.label && (
              <div className={row}>
                <span className="text-muted">Labels</span>
                {check(LABEL_NAMES[drawing.type] ?? 'Show price on the axis', s.showLabel, (v) => ({ showLabel: v }))}
              </div>
            )}
          </section>

          {caps.text && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] tracking-wide text-muted uppercase">Text</h3>
              <textarea rows={3} aria-label="Text" value={drawing.text ?? s.text} onChange={(e) => onChange({ text: e.target.value })}
                className="rounded border border-line bg-panel px-2 py-1 text-[12px]" />
              <label className={row}>
                <span className="text-muted">Font size</span>
                <select className={SELECT} value={s.fontSize} onChange={(e) => onChange({ fontSize: Number(e.target.value) })}>
                  {[10, 12, 14, 16, 20, 24, 28, 32].map((f) => <option key={f} value={f}>{f}px</option>)}
                </select>
              </label>
            </section>
          )}

          {caps.levels && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] tracking-wide text-muted uppercase">Levels</h3>
              <div className="grid grid-cols-4 gap-1">
                {FIB_CHOICES.map((lvl) => (
                  <label key={lvl} className="num flex items-center gap-1 text-[12px]">
                    <input type="checkbox" className="accent-accent" checked={s.levels.includes(lvl)}
                      onChange={(e) => onChange({ levels: e.target.checked ? [...s.levels, lvl].sort((a, b) => a - b) : s.levels.filter((x) => x !== lvl) })} />
                    {lvl}
                  </label>
                ))}
              </div>
            </section>
          )}

          {showPrices && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] tracking-wide text-muted uppercase">Coordinates</h3>
              {drawing.points.map((p, i) => (
                <label key={i} className={row}>
                  <span className="text-muted">{names[i]}</span>
                  <input type="number" step={step} defaultValue={p.price.toFixed(digits)} key={`${drawing.id}-${i}-${p.price}`}
                    onBlur={(e) => setPrice(i, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setPrice(i, e.currentTarget.value)}
                    className="num h-7 rounded border border-line bg-panel px-2 text-right text-[12px]" />
                </label>
              ))}
            </section>
          )}

          <section>
            {check('Locked (can’t be moved)', !!drawing.locked, (v) => ({ locked: v || undefined }) as Partial<Drawing>)}
          </section>
        </div>
        <div className="flex justify-between gap-2 border-t border-line px-4 py-3">
          <button type="button" className="rounded border border-line px-3 py-1.5 text-muted hover:text-fg"
            onClick={() => onChange({ color: undefined, width: undefined, dash: undefined, fill: undefined, fontSize: undefined, showLabel: undefined, levels: undefined })}>
            Reset style
          </button>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded bg-accent px-3 py-1.5 font-semibold text-white hover:brightness-110">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
