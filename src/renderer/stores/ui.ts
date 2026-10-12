import { create } from "zustand"
import { getPanelLayout } from "../lib/panelLayout.ts"
import {
  clampWidth,
  loadWidth,
  saveWidth,
  SIDE_PANEL_BOUNDS,
  SIDEBAR_BOUNDS,
  SIDEBAR_DEFAULT_WIDTH,
} from "../lib/panelWidth.ts"

export type SidePanelViewId = "details" | "files" | "changes" | "git" | "pullRequests" | "agents" | "browser"
export type SidePanelSize = "normal" | "wide"

const SIDEBAR_WIDTH_KEY = "kkcode.sidebarWidth"
const sidePanelWidthKeys: Record<SidePanelSize, string> = {
  normal: "kkcode.sidePanelWidth",
  wide: "kkcode.sidePanelWideWidth",
}

interface UiState {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly sidePanelOpen: boolean
  readonly sidebarOverlayOpen: boolean
  readonly sidePanelOverlayOpen: boolean
  /** The side panel view each thread last showed. Threads not in here show `lastSidePanelView`. */
  readonly sidePanelViews: Readonly<Record<string, SidePanelViewId>>
  readonly lastSidePanelView: SidePanelViewId
  /** A view asked for room, such as Files with a file open. */
  readonly sidePanelWide: boolean
  /** Docked side panel width per size, remembered separately. Null keeps the size's CSS default. */
  readonly sidePanelWidths: Readonly<Record<SidePanelSize, number | null>>
  /** Set by a view shortcut until the view takes focus. */
  readonly viewFocusRequest: SidePanelViewId | null
  /** The file whose diff the Changes view shows open. */
  readonly changesPath: string | null
  /** The page each thread's Browser view shows. Threads not in here have not opened one. */
  readonly browserUrls: Readonly<Record<string, string>>
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
  /** Shows `view` for the thread, opening the panel. `focus` also moves focus into the view. */
  readonly showView: (threadId: string, view: SidePanelViewId, options?: { readonly focus?: boolean }) => void
  /** Like `showView`, but hides the panel when it already shows `view`, as clicking an active activity bar icon does. */
  readonly toggleView: (threadId: string, view: SidePanelViewId, options?: { readonly focus?: boolean }) => void
  readonly clearViewFocusRequest: () => void
  readonly setSidePanelWide: (wide: boolean) => void
  readonly setChangesPath: (path: string | null) => void
  readonly setBrowserUrl: (threadId: string, url: string) => void
  readonly requestComposerFocus: () => void
  readonly requestInterrupt: () => void
  readonly setAddProjectOpen: (open: boolean) => void
  /** Opens and focuses the thread's find bar, replacing its query when one is given. */
  readonly openFind: (threadId: string, query?: string, messageId?: string) => void
  readonly closeFind: () => void
  readonly setFindQuery: (query: string) => void
  /** Clamps, applies and persists the desktop sidebar width. */
  readonly setSidebarWidth: (width: number) => void
  /** Clamps, applies and persists the docked side panel width for one size. Null restores its default. */
  readonly setSidePanelWidth: (size: SidePanelSize, width: number | null) => void
}

/** Whether the side panel shows its content in the current layout, docked or as an overlay. */
export const selectSidePanelShown = (state: Pick<UiState, "sidePanelOpen" | "sidePanelOverlayOpen">) =>
  getPanelLayout() === "wide" ? state.sidePanelOpen : state.sidePanelOverlayOpen

export const selectSidePanelView =
  (threadId: string) => (state: Pick<UiState, "sidePanelViews" | "lastSidePanelView">) =>
    state.sidePanelViews[threadId] ?? state.lastSidePanelView

const showPanel = () =>
  getPanelLayout() === "wide" ? { sidePanelOpen: true } : { sidePanelOverlayOpen: true, sidebarOverlayOpen: false }

const hidePanel = () => (getPanelLayout() === "wide" ? { sidePanelOpen: false } : { sidePanelOverlayOpen: false })

/** App-wide UI state driven by keybindings and shared across components without prop drilling. */
export const useUi = create<UiState>()((set, get) => ({
  sidebarOpen: true,
  sidebarWidth: loadWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_BOUNDS) ?? SIDEBAR_DEFAULT_WIDTH,
  sidePanelOpen: true,
  sidebarOverlayOpen: false,
  sidePanelOverlayOpen: false,
  sidePanelViews: {},
  lastSidePanelView: "details",
  sidePanelWide: false,
  sidePanelWidths: {
    normal: loadWidth(sidePanelWidthKeys.normal, SIDE_PANEL_BOUNDS),
    wide: loadWidth(sidePanelWidthKeys.wide, SIDE_PANEL_BOUNDS),
  },
  viewFocusRequest: null,
  changesPath: null,
  browserUrls: {},
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
  showView: (threadId, view, options) =>
    set((state) => ({
      sidePanelViews: { ...state.sidePanelViews, [threadId]: view },
      lastSidePanelView: view,
      viewFocusRequest: options?.focus ? view : null,
      ...showPanel(),
    })),
  toggleView: (threadId, view, options) => {
    const state = get()
    if (selectSidePanelShown(state) && selectSidePanelView(threadId)(state) === view) set(hidePanel())
    else state.showView(threadId, view, options)
  },
  clearViewFocusRequest: () => set({ viewFocusRequest: null }),
  setSidePanelWide: (sidePanelWide) => set({ sidePanelWide }),
  setChangesPath: (changesPath) => set({ changesPath }),
  setBrowserUrl: (threadId, url) => set((state) => ({ browserUrls: { ...state.browserUrls, [threadId]: url } })),
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
    const sidebarWidth = clampWidth(SIDEBAR_BOUNDS, width)
    saveWidth(SIDEBAR_WIDTH_KEY, sidebarWidth)
    set({ sidebarWidth })
  },
  setSidePanelWidth: (size, width) => {
    const clamped = width === null ? null : clampWidth(SIDE_PANEL_BOUNDS, width)
    saveWidth(sidePanelWidthKeys[size], clamped)
    set((state) => ({ sidePanelWidths: { ...state.sidePanelWidths, [size]: clamped } }))
  },
}))
