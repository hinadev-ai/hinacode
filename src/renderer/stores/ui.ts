import { create } from "zustand"
import type { FindMatch, FindRevealRequest } from "../lib/find.ts"
import { getPanelLayout } from "../lib/panelLayout.ts"
import type { EnvironmentId } from "../lib/rpc.ts"
import { cycleSwitcher, type ThreadSwitcher, visitRecent } from "../lib/threadSwitcher.ts"
import {
  clampSize,
  FILE_TREE_HEIGHT_BOUNDS,
  GIT_GRAPH_SPLIT_BOUNDS,
  loadSize,
  saveSize,
  SIDE_PANEL_BOUNDS,
  SIDEBAR_BOUNDS,
  SIDEBAR_DEFAULT_WIDTH,
  type SizeBounds,
} from "../lib/panelSize.ts"

export type SidePanelViewId =
  | "details"
  | "files"
  | "changes"
  | "git"
  | "pullRequests"
  | "agents"
  | "browser"
  | "tinyVm"
  | "devices"
export type SidePanelSize = "normal" | "wide"
const sidebarTabs = ["inbox", "threads", "archived"] as const
export type SidebarTab = (typeof sidebarTabs)[number]

export const pullRequestCodeViews = ["files", "guide"] as const
export type PullRequestCodeView = (typeof pullRequestCodeViews)[number]
/** Where a thread's tiny VM screen shows: its side panel view, or floating over the conversation. */
export type VmPlacement = "panel" | "floating"
/** Composer pickers a shortcut can open. */
export type ComposerPicker = "model" | "effort"

const pullRequestSections = ["links", "checks", "description", "comments"] as const
export type PullRequestSection = (typeof pullRequestSections)[number]

let findRevealRequests = 0

const SIDEBAR_WIDTH_KEY = "hinacode.sidebarWidth"
const SIDEBAR_PROJECTS_KEY = "hinacode.sidebarProjects"
const SIDEBAR_TAB_KEY = "hinacode.sidebarTab"
const RECENT_THREADS_KEY = "hinacode.recentThreads"
const PULL_REQUEST_CODE_VIEW_KEY = "hinacode.pullRequestCodeView"
const COLLAPSED_PULL_REQUEST_SECTIONS_KEY = "hinacode.collapsedPullRequestSections"
const VM_FLOATING_WIDTH_KEY = "hinacode.vmFloatingWidth"
const FILE_TREE_HEIGHT_KEY = "hinacode.fileTreeHeight"
const GIT_GRAPH_SPLIT_KEY = "hinacode.gitGraphSplit"
export const VM_FLOATING_BOUNDS: SizeBounds = { min: 240, max: 960 }
export const VM_FLOATING_DEFAULT_WIDTH = 320

function loadStrings(key: string): ReadonlyArray<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(stored) ? stored.filter((value) => typeof value === "string") : []
  } catch {
    return []
  }
}

const loadSidebarTab = (): SidebarTab =>
  sidebarTabs.find((tab) => tab === localStorage.getItem(SIDEBAR_TAB_KEY)) ?? "threads"

const loadPullRequestCodeView = (): PullRequestCodeView =>
  pullRequestCodeViews.find((view) => view === localStorage.getItem(PULL_REQUEST_CODE_VIEW_KEY)) ?? "files"

const isPullRequestSection = (value: string): value is PullRequestSection =>
  pullRequestSections.some((section) => section === value)

const sidePanelWidthKeys: Record<SidePanelSize, string> = {
  normal: "hinacode.sidePanelWidth",
  wide: "hinacode.sidePanelWideWidth",
}

interface UiState {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly sidePanelOpen: boolean
  readonly sidebarOverlayOpen: boolean
  readonly sidePanelOverlayOpen: boolean
  readonly sidebarTab: SidebarTab
  readonly pullRequestCodeView: PullRequestCodeView
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
  /** The Files view's tree height above an open file. */
  readonly fileTreeHeight: number
  readonly setFileTreeHeight: (height: number) => void
  /** The Git view's commit list height, in percent, above a commit's diff. */
  readonly gitGraphSplit: number
  readonly setGitGraphSplit: (split: number) => void
  /** Bumped to ask the composer to take focus. Subscribers react to changes, the value is meaningless. */
  readonly composerFocusRequest: number
  /** Bumped to ask the open thread to interrupt its running turn. */
  readonly interruptRequest: number
  /** Replaced to ask the composer to open one of its pickers. */
  readonly pickerRequest: { readonly picker: ComposerPicker } | null
  readonly addProjectOpen: boolean
  readonly resourcesOpen: boolean
  /** The thread the snooze picker is open for, or null. */
  readonly snoozeThreadId: string | null
  /** Where the Add project dialog starts, for opening it on a cloud that was just paired. */
  readonly addProjectEnvironment: EnvironmentId
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
  /** Persists the tab, so the sidebar reopens on it. */
  readonly setSidebarTab: (tab: SidebarTab) => void
  readonly setPullRequestCodeView: (view: PullRequestCodeView) => void
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
  readonly setAddProjectOpen: (open: boolean, environment?: EnvironmentId) => void
  readonly setResourcesOpen: (open: boolean) => void
  readonly setSnoozeThreadId: (threadId: string | null) => void
  /** Opens and focuses the thread's find bar, replacing its query when one is given. */
  readonly openFind: (threadId: string, query?: string, messageId?: string) => void
  readonly closeFind: () => void
  readonly setFindQuery: (query: string) => void
  readonly revealFindMatch: (match: FindMatch | null) => void
  /** Clamps, applies and persists the desktop sidebar width. */
  readonly setSidebarWidth: (width: number) => void
  /** Clamps, applies and persists the docked side panel width for one size. Null restores its default. */
  readonly setSidePanelWidth: (size: SidePanelSize, width: number | null) => void
  /** Threads the user opened, most recent first, kept across restarts. */
  readonly recentThreadIds: ReadonlyArray<string>
  readonly visitThread: (threadId: string) => void
  /** The Ctrl+Tab switcher while it is open. */
  readonly threadSwitcher: ThreadSwitcher | null
  /** Opens the switcher, or moves its highlight. `existing` drops threads deleted since the user opened them. */
  readonly cycleThreadSwitcher: (openThreadId: string | null, step: 1 | -1, existing: (id: string) => boolean) => void
  readonly closeThreadSwitcher: () => void
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
  sidebarWidth: loadSize(SIDEBAR_WIDTH_KEY, SIDEBAR_BOUNDS) ?? SIDEBAR_DEFAULT_WIDTH,
  sidePanelOpen: true,
  sidebarOverlayOpen: false,
  sidePanelOverlayOpen: false,
  sidebarTab: loadSidebarTab(),
  pullRequestCodeView: loadPullRequestCodeView(),
  sidebarQuery: "",
  sidebarProjectIds: loadStrings(SIDEBAR_PROJECTS_KEY),
  collapsedPullRequestSections: loadStrings(COLLAPSED_PULL_REQUEST_SECTIONS_KEY).filter(isPullRequestSection),
  sidePanelViews: {},
  lastSidePanelView: "details",
  sidePanelWide: false,
  sidePanelWidths: {
    normal: loadSize(sidePanelWidthKeys.normal, SIDE_PANEL_BOUNDS),
    wide: loadSize(sidePanelWidthKeys.wide, SIDE_PANEL_BOUNDS),
  },
  viewFocusRequest: null,
  changesPath: null,
  vmPlacements: {},
  vmFloatingWidth: loadSize(VM_FLOATING_WIDTH_KEY, VM_FLOATING_BOUNDS) ?? VM_FLOATING_DEFAULT_WIDTH,
  setVmPlacement: (threadId, placement) =>
    set((state) => ({ vmPlacements: { ...state.vmPlacements, [threadId]: placement } })),
  setVmFloatingWidth: (width) => {
    const clamped = width === null ? null : clampSize(VM_FLOATING_BOUNDS, width)
    saveSize(VM_FLOATING_WIDTH_KEY, clamped)
    set({ vmFloatingWidth: clamped ?? VM_FLOATING_DEFAULT_WIDTH })
  },
  fileTreeHeight: loadSize(FILE_TREE_HEIGHT_KEY, FILE_TREE_HEIGHT_BOUNDS) ?? 240,
  setFileTreeHeight: (fileTreeHeight) => {
    saveSize(FILE_TREE_HEIGHT_KEY, fileTreeHeight)
    set({ fileTreeHeight })
  },
  gitGraphSplit: loadSize(GIT_GRAPH_SPLIT_KEY, GIT_GRAPH_SPLIT_BOUNDS) ?? 55,
  setGitGraphSplit: (gitGraphSplit) => {
    saveSize(GIT_GRAPH_SPLIT_KEY, gitGraphSplit)
    set({ gitGraphSplit })
  },
  composerFocusRequest: 0,
  interruptRequest: 0,
  pickerRequest: null,
  addProjectOpen: false,
  resourcesOpen: false,
  addProjectEnvironment: null,
  snoozeThreadId: null,
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
  setSidebarTab: (sidebarTab) => {
    localStorage.setItem(SIDEBAR_TAB_KEY, sidebarTab)
    set({ sidebarTab })
  },
  setPullRequestCodeView: (pullRequestCodeView) => {
    localStorage.setItem(PULL_REQUEST_CODE_VIEW_KEY, pullRequestCodeView)
    set({ pullRequestCodeView })
  },
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
  setAddProjectOpen: (addProjectOpen, environment = null) =>
    set({ addProjectOpen, addProjectEnvironment: environment }),
  setResourcesOpen: (resourcesOpen) => set({ resourcesOpen }),
  setSnoozeThreadId: (snoozeThreadId) => set({ snoozeThreadId }),
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
    const sidebarWidth = clampSize(SIDEBAR_BOUNDS, width)
    saveSize(SIDEBAR_WIDTH_KEY, sidebarWidth)
    set({ sidebarWidth })
  },
  setSidePanelWidth: (size, width) => {
    const clamped = width === null ? null : clampSize(SIDE_PANEL_BOUNDS, width)
    saveSize(sidePanelWidthKeys[size], clamped)
    set((state) => ({ sidePanelWidths: { ...state.sidePanelWidths, [size]: clamped } }))
  },
  recentThreadIds: loadStrings(RECENT_THREADS_KEY),
  visitThread: (threadId) => {
    const recentThreadIds = visitRecent(get().recentThreadIds, threadId)
    localStorage.setItem(RECENT_THREADS_KEY, JSON.stringify(recentThreadIds))
    set({ recentThreadIds })
  },
  threadSwitcher: null,
  cycleThreadSwitcher: (openThreadId, step, existing) =>
    set((state) => ({
      threadSwitcher: cycleSwitcher(state.threadSwitcher, state.recentThreadIds.filter(existing), openThreadId, step),
    })),
  closeThreadSwitcher: () => set({ threadSwitcher: null }),
}))
