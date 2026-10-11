import { create } from "zustand"

interface UiState {
  readonly sidebarOpen: boolean
  readonly sidePanelOpen: boolean
  /** Bumped to ask the composer to take focus. Subscribers react to changes, the value is meaningless. */
  readonly composerFocusRequest: number
  /** Bumped to ask the open thread to interrupt its running turn. */
  readonly interruptRequest: number
  readonly addProjectOpen: boolean
  /** Project whose New thread dialog is open, or null. */
  readonly newThreadProjectId: string | null
  readonly toggleSidebar: () => void
  readonly toggleSidePanel: () => void
  readonly requestComposerFocus: () => void
  readonly requestInterrupt: () => void
  readonly setAddProjectOpen: (open: boolean) => void
  readonly setNewThreadProjectId: (projectId: string | null) => void
}

/** App-wide UI state driven by keybindings and shared across components without prop drilling. */
export const useUi = create<UiState>()((set) => ({
  sidebarOpen: true,
  sidePanelOpen: true,
  composerFocusRequest: 0,
  interruptRequest: 0,
  addProjectOpen: false,
  newThreadProjectId: null,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleSidePanel: () => set((state) => ({ sidePanelOpen: !state.sidePanelOpen })),
  requestComposerFocus: () => set((state) => ({ composerFocusRequest: state.composerFocusRequest + 1 })),
  requestInterrupt: () => set((state) => ({ interruptRequest: state.interruptRequest + 1 })),
  setAddProjectOpen: (addProjectOpen) => set({ addProjectOpen }),
  setNewThreadProjectId: (newThreadProjectId) => set({ newThreadProjectId }),
}))
