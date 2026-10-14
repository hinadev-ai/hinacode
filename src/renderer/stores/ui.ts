import { create } from "zustand"
import type { FindMatch, FindRevealRequest } from "../lib/find.ts"
import { getPanelLayout } from "../lib/panelLayout.ts"
import {
  clampWidth,
  loadWidth,
  saveWidth,
  SIDE_PANEL_BOUNDS,
  SIDEBAR_BOUNDS,
  SIDEBAR_DEFAULT_WIDTH,
  type WidthBounds,
} from "../lib/panelWidth.ts"

export type SidePanelViewId = "details" | "files" | "changes" | "git" | "pullRequests" | "agents" | "browser" | "tinyVm"
export type SidePanelSize = "normal" | "wide"
export type SidebarTab = "threads" | "archived"
/** Where a thread's tiny VM screen shows: its side panel view, or floating over the conversation. */
export type VmPlacement = "panel" | "floating"
/** Composer pickers a shortcut can open. */
export type ComposerPicker = "model" | "effort"

const pullRequestSections = ["checks", "description"] as const
export type PullRequestSection = (typeof pullRequestSections)[number]

let findRevealRequests = 0

const SIDEBAR_WIDTH_KEY = "kkcode.sidebarWidth"
const SIDEBAR_PROJECTS_KEY = "kkcode.sidebarProjects"
const COLLAPSED_PULL_REQUEST_SECTIONS_KEY = "kkcode.collapsedPullRequestSections"
const VM_FLOATING_WIDTH_KEY = "kkcode.vmFloatingWidth"
export const VM_FLOATING_BOUNDS: WidthBounds = { min: 240, max: 960 }
export const VM_FLOATING_DEFAULT_WIDTH = 320

function loadStrings(key: string): ReadonlyArray<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(stored) ? stored.filter((value) => typeof value === "string") : []
  } catch {
    return []
  }
}

const isPullRequestSection = (value: string): value is PullRequestSection =>
  pullRequestSections.some((section) => section === value)

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
  readonly sidebarTab: SidebarTab
  /** Narrows the sidebar to threads whose title, or whose project's name, contains it. */
  readonly sidebarQuery: string
  /** The projects the sidebar shows. Empty shows every project. */
  readonly sidebarProjectIds: ReadonlyArray<string>
  /** PR tab sections the user collapsed. They stay collapsed for every pull request. */
  readonly collapsedPullRequestSections: ReadonlyArray<PullRequestSection>
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
  /** Threads whose tiny VM screen floats over the conversation. The rest show it in the side panel. */
  readonly vmPlacements: Readonly<Record<string, VmPlacement>>
  /** The floating screen's width; its height follows the VM's aspect ratio. */
  readonly vmFloatingWidth: number
  readonly setVmPlacement: (threadId: string, placement: VmPlacement) => void
  /** Clamps, applies and persists the floating screen's width. Null restores the default. */
  readonly setVmFloatingWidth: (width: number | null) => void
  /** Bumped to ask the composer to take focus. Subscribers react to changes, the value is meaningless. */
  readonly composerFocusRequest: number
  /** Bumped to ask the open thread to interrupt its running turn. */
  readonly interruptRequest: number
  /** Replaced to ask the composer to open one of its pickers. */
  readonly pickerRequest: { readonly picker: ComposerPicker } | null
  readonly addProjectOpen: boolean
  /** The thread whose find bar is open, or null. */
  readonly findThreadId: string | null
  readonly findQuery: string
  /** The message to start at, set when global search opens the bar on one of its results. */
  readonly findMessageId: string | null
  /** Bumped to ask the find bar to focus and select its field. */
  readonly findFocusRequest: number
  readonly findReveal: FindRevealRequest | null
  readonly toggleSidebar: () => void
  readonly toggleSidePanel: () => void
  readonly setSidebarOverlayOpen: (open: boolean) => void
  readonly setSidePanelOverlayOpen: (open: boolean) => void
  readonly setSidebarTab: (tab: SidebarTab) => void
  readonly setSidebarQuery: (query: string) => void
  /** Persists the sidebar's project filter. */
  readonly setSidebarProjectIds: (ids: ReadonlyArray<string>) => void
  /** Persists whether a PR tab section is open. */
  readonly setPullRequestSectionOpen: (section: PullRequestSection, open: boolean) => void
  /** Shows `view` for the thread, opening the panel. `focus` also moves focus into the view. */
  readonly showView: (threadId: string, view: SidePanelViewId, options?: { readonly focus?: boolean }) => void
  /** Like `showView`, but hides the panel when it already shows `view`, as clicking an active activity bar icon does. */
  readonly toggleView: (threadId: string, view: SidePanelViewId, options?: { readonly focus?: boolean }) => void
  readonly clearViewFocusRequest: () => void
  readonly setSidePanelWide: (wide: boolean) => void
  readonly setChangesPath: (path: string | null) => void
  readonly requestComposerFocus: () => void
  readonly requestInterrupt: () => void
  readonly requestPicker: (picker: ComposerPicker) => void
  readonly setAddProjectOpen: (open: boolean) => void
  /** Opens and focuses the thread's find bar, replacing its query when one is given. */
  readonly openFind: (threadId: string, query?: string, messageId?: string) => void
  readonly closeFind: () => void
  readonly setFindQuery: (query: string) => void
  readonly revealFindMatch: (match: FindMatch | null) => void
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
  sidebarTab: "threads",
  sidebarQuery: "",
  sidebarProjectIds: loadStrings(SIDEBAR_PROJECTS_KEY),
  collapsedPullRequestSections: loadStrings(COLLAPSED_PULL_REQUEST_SECTIONS_KEY).filter(isPullRequestSection),
  sidePanelViews: {},
  lastSidePanelView: "details",
  sidePanelWide: false,
  sidePanelWidths: {
    normal: loadWidth(sidePanelWidthKeys.normal, SIDE_PANEL_BOUNDS),
    wide: loadWidth(sidePanelWidthKeys.wide, SIDE_PANEL_BOUNDS),
  },
  viewFocusRequest: null,
  changesPath: null,
  vmPlacements: {},
  vmFloatingWidth: loadWidth(VM_FLOATING_WIDTH_KEY, VM_FLOATING_BOUNDS) ?? VM_FLOATING_DEFAULT_WIDTH,
  setVmPlacement: (threadId, placement) =>
    set((state) => ({ vmPlacements: { ...state.vmPlacements, [threadId]: placement } })),
  setVmFloatingWidth: (width) => {
    const clamped = width === null ? null : clampWidth(VM_FLOATING_BOUNDS, width)
    saveWidth(VM_FLOATING_WIDTH_KEY, clamped)
    set({ vmFloatingWidth: clamped ?? VM_FLOATING_DEFAULT_WIDTH })
  },
  composerFocusRequest: 0,
  interruptRequest: 0,
  pickerRequest: null,
  addProjectOpen: false,
  findThreadId: null,
  findQuery: "",
  findMessageId: null,
  findFocusRequest: 0,
  findReveal: null,
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
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  setSidebarQuery: (sidebarQuery) => set({ sidebarQuery }),
  setSidebarProjectIds: (sidebarProjectIds) => {
    localStorage.setItem(SIDEBAR_PROJECTS_KEY, JSON.stringify(sidebarProjectIds))
    set({ sidebarProjectIds })
  },
  setPullRequestSectionOpen: (section, open) => {
    const others = get().collapsedPullRequestSections.filter((collapsed) => collapsed !== section)
    const collapsedPullRequestSections = open ? others : [...others, section]
    localStorage.setItem(COLLAPSED_PULL_REQUEST_SECTIONS_KEY, JSON.stringify(collapsedPullRequestSections))
    set({ collapsedPullRequestSections })
  },
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
  requestComposerFocus: () => set((state) => ({ composerFocusRequest: state.composerFocusRequest + 1 })),
  requestInterrupt: () => set((state) => ({ interruptRequest: state.interruptRequest + 1 })),
  requestPicker: (picker) => set({ pickerRequest: { picker } }),
  setAddProjectOpen: (addProjectOpen) => set({ addProjectOpen }),
  openFind: (threadId, query, messageId) =>
    set((state) => ({
      findThreadId: threadId,
      findQuery: query ?? state.findQuery,
      findMessageId: messageId ?? null,
      findFocusRequest: state.findFocusRequest + 1,
    })),
  closeFind: () => set({ findThreadId: null, findReveal: null }),
  setFindQuery: (findQuery) => set({ findQuery, findMessageId: null }),
  revealFindMatch: (match) => set({ findReveal: match && { id: ++findRevealRequests, match } }),
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
