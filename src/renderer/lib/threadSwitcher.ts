const RECENT_LIMIT = 10

export const visitRecent = (recent: ReadonlyArray<string>, threadId: string): ReadonlyArray<string> =>
  [threadId, ...recent.filter((id) => id !== threadId)].slice(0, RECENT_LIMIT)

export interface ThreadSwitcher {
  readonly threadIds: ReadonlyArray<string>
  readonly index: number
}

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
