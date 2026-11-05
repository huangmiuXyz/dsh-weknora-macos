/**
 * The bridge between one waiting tool call and the card's save button.
 *
 * `weknora_run` should not end while the user is being asked for an API key:
 * the card renders on the call's own row, and the call is the thing that pays
 * for the wait. `KeyGate` is that wait — a set of pending resolvers that the
 * route releases after a successful save.
 *
 * It never accepts a key itself; it only signals that one was saved. The tool
 * then re-reads `process.env`, which `saveApiKey` already updated, so the two
 * sides cannot disagree about what was stored.
 */
export class KeyGate {
  #waiters = new Set()

  /** Release every waiter. Safe to call when nobody waits. */
  notify() {
    for (const finish of [...this.#waiters]) finish(true)
  }

  /**
   * Resolve `true` when a key is saved before the deadline, `false` on timeout
   * or cancellation. Cancellation is not an error: a user who stops the turn
   * gets their call back immediately.
   */
  wait({ timeoutMs, signal } = {}) {
    if (signal?.aborted === true) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        this.#waiters.delete(finish)
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.#waiters.add(finish)
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }
}