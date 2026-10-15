import { create } from "zustand"

export interface BrowserTab {
  readonly id: string
  /** The page the tab shows, or null before one is opened. */
  readonly url: string | null
  readonly title: string | null
}

/** One thread's browser tabs. Never empty, and `activeId` is always one of them. */
export interface BrowserTabs {
  readonly tabs: ReadonlyArray<BrowserTab>
  readonly activeId: string
}

const emptyTab = (): BrowserTab => ({ id: crypto.randomUUID(), url: null, title: null })

/** What every thread starts with. Shared, so a selector returns the same object until the thread changes it. */
export const NO_TABS: BrowserTabs = { tabs: [{ id: "first", url: null, title: null }], activeId: "first" }

export const openTab = (state: BrowserTabs): BrowserTabs => {
  const tab = emptyTab()
  return { tabs: [...state.tabs, tab], activeId: tab.id }
}

/** Closing the shown tab shows its right neighbor, or its left one at the end of the row, as browsers do. */
export const closeTab = (state: BrowserTabs, id: string): BrowserTabs => {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  // A fresh id, so the closed tab's webview is not reused for the empty one.
  if (tabs.length === 0) return openTab({ ...state, tabs })
  if (state.activeId !== id) return { tabs, activeId: state.activeId }
  return { tabs, activeId: (tabs[index] ?? tabs[index - 1]!).id }
}

interface BrowserTabsState {
  /** Threads that have not touched their tabs are not in here and have `NO_TABS`. Kept in memory only. */
  readonly threads: Readonly<Record<string, BrowserTabs>>
  /** The tab whose address field takes focus once it renders, set when the user opens a tab. */
  readonly addressFocusRequest: string | null
  readonly openTab: (threadId: string) => void
  readonly closeTab: (threadId: string, tabId: string) => void
  readonly selectTab: (threadId: string, tabId: string) => void
  readonly updateTab: (threadId: string, tabId: string, patch: Partial<Pick<BrowserTab, "url" | "title">>) => void
  readonly clearAddressFocusRequest: () => void
}

export const selectBrowserTabs = (threadId: string) => (state: Pick<BrowserTabsState, "threads">) =>
  state.threads[threadId] ?? NO_TABS

export const useBrowserTabs = create<BrowserTabsState>()((set) => {
  const change = (threadId: string, update: (tabs: BrowserTabs) => BrowserTabs) =>
    set((state) => ({ threads: { ...state.threads, [threadId]: update(selectBrowserTabs(threadId)(state)) } }))

  return {
    threads: {},
    addressFocusRequest: null,
    openTab: (threadId) =>
      set((state) => {
        const next = openTab(selectBrowserTabs(threadId)(state))
        return { threads: { ...state.threads, [threadId]: next }, addressFocusRequest: next.activeId }
      }),
    closeTab: (threadId, tabId) => change(threadId, (tabs) => closeTab(tabs, tabId)),
    selectTab: (threadId, tabId) => change(threadId, (tabs) => ({ ...tabs, activeId: tabId })),
    updateTab: (threadId, tabId, patch) =>
      change(threadId, (tabs) => ({
        ...tabs,
        tabs: tabs.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
      })),
    clearAddressFocusRequest: () => set({ addressFocusRequest: null }),
  }
})
