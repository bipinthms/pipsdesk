/**
 * Actions still being sent, by key. A second request for the same action while the
 * first is in flight is dropped, so a double-click or key repeat can never send an
 * order twice. Different actions (another ticket, a close) are not held up.
 */
export class InFlight {
  private keys = new Set<string>()

  has(key: string): boolean {
    return this.keys.has(key)
  }

  /** Runs `fn` unless `key` is already running. Resolves false when dropped; rethrows `fn`'s error. */
  async run(key: string, fn: () => Promise<void>): Promise<boolean> {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    try {
      await fn()
    } finally {
      this.keys.delete(key)
    }
    return true
  }
}
