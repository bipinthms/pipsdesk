import { ApiError } from '../api/client'
import type { TradeResponse } from '../api/types'
import { errorText } from '../components/Confirm'
import { toast } from '../components/Toasts'

/**
 * Tickets this UI closed or cancelled itself. Disappearances of these from the
 * stream are expected; anything else (SL/TP hit, stop-out) gets a toast.
 */
export const expectedRemovals = new Set<number>()

/** Run a trade request with success/warning/error toasts. Rethrows so a modal can stay open. */
export async function trade(fn: () => Promise<TradeResponse>, success: (r: TradeResponse) => string): Promise<TradeResponse> {
  try {
    const r = await fn()
    toast('success', success(r))
    for (const w of r.warnings) toast('warn', w)
    return r
  } catch (e) {
    // An unclear outcome must be read: the order may have been placed.
    toast('error', errorText(e), e instanceof ApiError && e.kind === 'unknown' ? 20_000 : undefined)
    throw e
  }
}
