/**
 * The tabs after the user opens `threadId`. A thread with a tab keeps it. Otherwise it takes over the tab the
 * user was last in, as a browser tab follows its links, or gets a new tab when there is none.
 */
export function navigateTabs(
  tabs: ReadonlyArray<string>,
  recent: ReadonlyArray<string>,
  threadId: string,
): ReadonlyArray<string> {
  const open = new Set(tabs)
  if (open.has(threadId)) return tabs
  const current = recent.find((id) => open.has(id))
  return current === undefined ? [...tabs, threadId] : tabs.map((id) => (id === current ? threadId : id))
}

/** The tabs with `threadId` opened at the end. The open thread keeps a tab too, so opening one never loses it. */
export function openTab(
  tabs: ReadonlyArray<string>,
  threadId: string,
  openThreadId: string | null,
): ReadonlyArray<string> {
  const kept = [openThreadId, threadId].filter((id): id is string => id !== null && !tabs.includes(id))
  return kept.length === 0 ? tabs : [...tabs, ...new Set(kept)]
}

/** The tab that takes over when `threadId`'s tab closes: the one to its right, else to its left. */
export function neighborTab(tabs: ReadonlyArray<string>, threadId: string): string | undefined {
  const index = tabs.indexOf(threadId)
  return tabs[index + 1] ?? tabs[index - 1]
}
