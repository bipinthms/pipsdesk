// Collapse / expand controls for the panels around the chart.

type Direction = 'left' | 'right' | 'up' | 'down'

const CHEVRON: Record<Direction, string> = {
  left: 'M10 3 L5 8 L10 13',
  right: 'M6 3 L11 8 L6 13',
  up: 'M3 10 L8 5 L13 10',
  down: 'M3 6 L8 11 L13 6',
}

/** A small chevron button; `direction` is where the panel goes when clicked. */
export function PanelToggle({ direction, label, onClick }: { direction: Direction; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:bg-panel-2 hover:text-fg"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d={CHEVRON[direction]} />
      </svg>
    </button>
  )
}

/** What a collapsed side panel leaves behind: a thin strip that expands it again. */
export function PanelRail({ side, label, name, onExpand }: { side: 'left' | 'right'; label: string; name: string; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Show ${name}`}
      aria-label={`Show ${name}`}
      className="flex h-full w-7 flex-col items-center gap-2 py-2 text-muted hover:bg-panel-2 hover:text-fg"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d={CHEVRON[side === 'left' ? 'right' : 'left']} />
      </svg>
      <span className="text-[11px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">{label}</span>
    </button>
  )
}
