const RECENT_LIMIT = 10

/** The recent threads, most recent first, after the user opens `threadId`. */
export const visitRecent = (recent: ReadonlyArray<string>, threadId: string): ReadonlyArray<string> =>
  [threadId, ...recent.filter((id) => id !== threadId)].slice(0, RECENT_LIMIT)

export interface ThreadSwitcher {
  /** The recent threads when the switcher opened, so the order holds still while the user cycles. */
  readonly threadIds: ReadonlyArray<string>
  /** The highlighted thread, which opens when the user lets go of the modifier. */
  readonly index: number
}

/**
 * Opens the switcher on the thread one `step` away from the open one, or moves the highlight `step`
 * further, wrapping around. Forward from outside a thread lands on the latest thread rather than skipping it.
 * Null when there is no other thread to switch to.
 */
export function cycleSwitcher(
  switcher: ThreadSwitcher | null,
  recent: ReadonlyArray<string>,
  openThreadId: string | null,
  step: 1 | -1,
): ThreadSwitcher | null {
  if (switcher) {
    const count = switcher.threadIds.length
    return { ...switcher, index: (switcher.index + step + count) % count }
  }
  if (!recent.some((id) => id !== openThreadId)) return null
  const first = recent[0] === openThreadId ? 1 : 0
  return { threadIds: recent, index: step === 1 ? first : recent.length - 1 }
}
