import { create } from "zustand"

export interface BrowserTab {
  readonly id: string
  readonly url: string | null
  readonly title: string | null
}

export interface BrowserTabs {
  readonly tabs: ReadonlyArray<BrowserTab>
  readonly activeId: string
}

const emptyTab = (): BrowserTab => ({ id: crypto.randomUUID(), url: null, title: null })

export const NO_TABS: BrowserTabs = { tabs: [{ id: "first", url: null, title: null }], activeId: "first" }

export const openTab = (state: BrowserTabs): BrowserTabs => {
  const tab = emptyTab()
  return { tabs: [...state.tabs, tab], activeId: tab.id }
}

export const closeTab = (state: BrowserTabs, id: string): BrowserTabs => {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) return openTab({ ...state, tabs })
  if (state.activeId !== id) return { tabs, activeId: state.activeId }
  return { tabs, activeId: (tabs[index] ?? tabs[index - 1]!).id }
}

interface BrowserTabsState {
  readonly threads: Readonly<Record<string, BrowserTabs>>
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
