import { create } from "zustand"
import { getPanelLayout } from "../lib/panelLayout.ts"
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth } from "../lib/sidebarWidth.ts"

interface UiState {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly sidePanelOpen: boolean
  readonly sidebarOverlayOpen: boolean
  readonly sidePanelOverlayOpen: boolean
  /** Bumped to ask the composer to take focus. Subscribers react to changes, the value is meaningless. */
  readonly composerFocusRequest: number
  /** Bumped to ask the open thread to interrupt its running turn. */
  readonly interruptRequest: number
  readonly addProjectOpen: boolean
  /** The thread whose find bar is open, or null. */
  readonly findThreadId: string | null
  readonly findQuery: string
  /** The message to start at, set when global search opens the bar on one of its results. */
  readonly findMessageId: string | null
  /** Bumped to ask the find bar to focus and select its field. */
  readonly findFocusRequest: number
  readonly toggleSidebar: () => void
  readonly toggleSidePanel: () => void
  readonly setSidebarOverlayOpen: (open: boolean) => void
  readonly setSidePanelOverlayOpen: (open: boolean) => void
  readonly requestComposerFocus: () => void
  readonly requestInterrupt: () => void
  readonly setAddProjectOpen: (open: boolean) => void
  /** Opens and focuses the thread's find bar, replacing its query when one is given. */
  readonly openFind: (threadId: string, query?: string, messageId?: string) => void
  readonly closeFind: () => void
  readonly setFindQuery: (query: string) => void
  /** Clamps, applies and persists the desktop sidebar width. */
  readonly setSidebarWidth: (width: number) => void
}

/** App-wide UI state driven by keybindings and shared across components without prop drilling. */
export const useUi = create<UiState>()((set) => ({
  sidebarOpen: true,
  sidebarWidth: loadSidebarWidth(),
  sidePanelOpen: true,
  sidebarOverlayOpen: false,
  sidePanelOverlayOpen: false,
  composerFocusRequest: 0,
  interruptRequest: 0,
  addProjectOpen: false,
  findThreadId: null,
  findQuery: "",
  findMessageId: null,
  findFocusRequest: 0,
  toggleSidebar: () =>
    set((state) =>
      getPanelLayout() === "compact"
        ? { sidebarOverlayOpen: !state.sidebarOverlayOpen, sidePanelOverlayOpen: false }
        : { sidebarOpen: !state.sidebarOpen, sidebarOverlayOpen: false },
    ),
  toggleSidePanel: () =>
    set((state) =>
      getPanelLayout() === "wide"
        ? { sidePanelOpen: !state.sidePanelOpen, sidePanelOverlayOpen: false }
        : { sidePanelOverlayOpen: !state.sidePanelOverlayOpen, sidebarOverlayOpen: false },
    ),
  setSidebarOverlayOpen: (open) =>
    set((state) => ({ sidebarOverlayOpen: open, sidePanelOverlayOpen: open ? false : state.sidePanelOverlayOpen })),
  setSidePanelOverlayOpen: (open) =>
    set((state) => ({ sidePanelOverlayOpen: open, sidebarOverlayOpen: open ? false : state.sidebarOverlayOpen })),
  requestComposerFocus: () => set((state) => ({ composerFocusRequest: state.composerFocusRequest + 1 })),
  requestInterrupt: () => set((state) => ({ interruptRequest: state.interruptRequest + 1 })),
  setAddProjectOpen: (addProjectOpen) => set({ addProjectOpen }),
  openFind: (threadId, query, messageId) =>
    set((state) => ({
      findThreadId: threadId,
      findQuery: query ?? state.findQuery,
      findMessageId: messageId ?? null,
      findFocusRequest: state.findFocusRequest + 1,
    })),
  closeFind: () => set({ findThreadId: null }),
  setFindQuery: (findQuery) => set({ findQuery, findMessageId: null }),
  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width)
    saveSidebarWidth(sidebarWidth)
    set({ sidebarWidth })
  },
}))
