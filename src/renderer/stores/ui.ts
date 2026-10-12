import { create } from "zustand"
import { getPanelLayout } from "../lib/panelLayout.ts"

interface UiState {
  readonly sidebarOpen: boolean
  readonly sidePanelOpen: boolean
  readonly sidebarOverlayOpen: boolean
  readonly sidePanelOverlayOpen: boolean
  /** Bumped to ask the composer to take focus. Subscribers react to changes, the value is meaningless. */
  readonly composerFocusRequest: number
  /** Bumped to ask the open thread to interrupt its running turn. */
  readonly interruptRequest: number
  readonly addProjectOpen: boolean
  /** Project whose New thread dialog is open, or null. */
  readonly newThreadProjectId: string | null
  readonly toggleSidebar: () => void
  readonly toggleSidePanel: () => void
  readonly setSidebarOverlayOpen: (open: boolean) => void
  readonly setSidePanelOverlayOpen: (open: boolean) => void
  readonly requestComposerFocus: () => void
  readonly requestInterrupt: () => void
  readonly setAddProjectOpen: (open: boolean) => void
  readonly setNewThreadProjectId: (projectId: string | null) => void
}

/** App-wide UI state driven by keybindings and shared across components without prop drilling. */
export const useUi = create<UiState>()((set) => ({
  sidebarOpen: true,
  sidePanelOpen: true,
  sidebarOverlayOpen: false,
  sidePanelOverlayOpen: false,
  composerFocusRequest: 0,
  interruptRequest: 0,
  addProjectOpen: false,
  newThreadProjectId: null,
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
  setNewThreadProjectId: (newThreadProjectId) => set({ newThreadProjectId }),
}))
