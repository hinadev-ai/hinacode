import { create } from "zustand"
import type { ChangesScope } from "../../shared/domain.ts"
import type { FindMatch, FindRevealRequest } from "../lib/find.ts"
import { getPanelLayout, usePanelLayout } from "../lib/panelLayout.ts"
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
  | "sidechat"
  | "artifacts"
const sidebarTabs = ["inbox", "threads"] as const
export type SidebarTab = (typeof sidebarTabs)[number]

export const pullRequestTabs = ["info", "files", "guide"] as const
export type PullRequestTab = (typeof pullRequestTabs)[number]
export type VmPlacement = "panel" | "floating"
export type ComposerPicker = "model" | "effort"

const pullRequestSections = ["links", "checks", "description", "comments"] as const
export type PullRequestSection = (typeof pullRequestSections)[number]

let findRevealRequests = 0

const SIDEBAR_WIDTH_KEY = "hinacode.sidebarWidth"
const SIDEBAR_PROJECTS_KEY = "hinacode.sidebarProjects"
const SIDEBAR_TAB_KEY = "hinacode.sidebarTab"
const RECENT_THREADS_KEY = "hinacode.recentThreads"
const PULL_REQUEST_TAB_KEY = "hinacode.pullRequestTab"
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

const INBOX_ACTIVITY_KEY = "hinacode.inboxActivityShown"
const WORKING_FOLDED_KEY = "hinacode.inboxWorkingFolded"

const loadSidebarTab = (): SidebarTab =>
  sidebarTabs.find((tab) => tab === localStorage.getItem(SIDEBAR_TAB_KEY)) ?? "threads"

const loadPullRequestTab = (): PullRequestTab =>
  pullRequestTabs.find((tab) => tab === localStorage.getItem(PULL_REQUEST_TAB_KEY)) ?? "info"

const isPullRequestSection = (value: string): value is PullRequestSection =>
  pullRequestSections.some((section) => section === value)

const SIDE_PANEL_WIDTH_KEY = "hinacode.sidePanelWidth"

interface UiState {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly sidePanelOpen: boolean
  readonly sidebarOverlayOpen: boolean
  readonly sidePanelOverlayOpen: boolean
  readonly sidebarTab: SidebarTab
  readonly inboxActivityShown: boolean
  readonly inboxWorkingFolded: boolean
  readonly pickedPullRequests: Readonly<Record<string, string>>
  readonly pickPullRequest: (threadId: string, url: string) => void
  readonly pullRequestTab: PullRequestTab
  readonly linkedPullRequestsOpen: boolean
  readonly sidebarQuery: string
  readonly sidebarProjectIds: ReadonlyArray<string>
  readonly collapsedPullRequestSections: ReadonlyArray<PullRequestSection>
  readonly sidePanelViews: Readonly<Record<string, SidePanelViewId>>
  readonly lastSidePanelView: SidePanelViewId
  readonly sidePanelWidth: number | null
  readonly sidePanelExpanded: boolean
  readonly viewFocusRequest: SidePanelViewId | null
  readonly changesPath: string | null
  readonly changesScopes: Readonly<Record<string, ChangesScope>>
  readonly setChangesScope: (threadId: string, scope: ChangesScope) => void
  readonly vmPlacements: Readonly<Record<string, VmPlacement>>
  readonly vmFloatingWidth: number
  readonly setVmPlacement: (threadId: string, placement: VmPlacement) => void
  readonly setVmFloatingWidth: (width: number | null) => void
  readonly fileTreeHeight: number
  readonly setFileTreeHeight: (height: number) => void
  readonly gitGraphSplit: number
  readonly setGitGraphSplit: (split: number) => void
  readonly composerFocusRequest: number
  readonly interruptRequest: number
  readonly pickerRequest: { readonly picker: ComposerPicker; readonly inSidechat: boolean } | null
  readonly addProjectOpen: boolean
  readonly resourcesOpen: boolean
  readonly snoozeThreadId: string | null
  readonly importSessionProjectId: string | null
  readonly addProjectEnvironment: EnvironmentId
  readonly findThreadId: string | null
  readonly findQuery: string
  readonly findMessageId: string | null
  readonly findFocusRequest: number
  readonly findReveal: FindRevealRequest | null
  readonly toggleSidebar: () => void
  readonly toggleSidePanel: () => void
  readonly toggleSidePanelExpanded: () => void
  readonly setSidebarOverlayOpen: (open: boolean) => void
  readonly setSidePanelOverlayOpen: (open: boolean) => void
  readonly setSidebarTab: (tab: SidebarTab) => void
  readonly setInboxActivityShown: (shown: boolean) => void
  readonly setInboxWorkingFolded: (folded: boolean) => void
  readonly setPullRequestTab: (tab: PullRequestTab) => void
  readonly setLinkedPullRequestsOpen: (open: boolean) => void
  readonly setSidebarQuery: (query: string) => void
  readonly setSidebarProjectIds: (ids: ReadonlyArray<string>) => void
  readonly setPullRequestSectionOpen: (section: PullRequestSection, open: boolean) => void
  readonly showView: (threadId: string, view: SidePanelViewId, options?: { readonly focus?: boolean }) => void
  readonly toggleView: (threadId: string, view: SidePanelViewId, options?: { readonly focus?: boolean }) => void
  readonly clearViewFocusRequest: () => void
  readonly setChangesPath: (path: string | null) => void
  readonly requestComposerFocus: () => void
  readonly requestInterrupt: () => void
  readonly requestPicker: (picker: ComposerPicker) => void
  readonly setAddProjectOpen: (open: boolean, environment?: EnvironmentId) => void
  readonly setResourcesOpen: (open: boolean) => void
  readonly setSnoozeThreadId: (threadId: string | null) => void
  readonly setImportSessionProjectId: (projectId: string | null) => void
  readonly openFind: (threadId: string, query?: string, messageId?: string) => void
  readonly closeFind: () => void
  readonly setFindQuery: (query: string) => void
  readonly revealFindMatch: (match: FindMatch | null) => void
  readonly setSidebarWidth: (width: number) => void
  readonly setSidePanelWidth: (width: number | null) => void
  readonly recentThreadIds: ReadonlyArray<string>
  readonly visitThread: (threadId: string) => void
  readonly threadSwitcher: ThreadSwitcher | null
  readonly cycleThreadSwitcher: (openThreadId: string | null, step: 1 | -1, existing: (id: string) => boolean) => void
  readonly closeThreadSwitcher: () => void
}

export const selectSidePanelShown = (state: Pick<UiState, "sidePanelOpen" | "sidePanelOverlayOpen">) =>
  getPanelLayout() === "wide" ? state.sidePanelOpen : state.sidePanelOverlayOpen

export const selectSidePanelView =
  (threadId: string) => (state: Pick<UiState, "sidePanelViews" | "lastSidePanelView">) =>
    state.sidePanelViews[threadId] ?? state.lastSidePanelView

const showPanel = () =>
  getPanelLayout() === "wide" ? { sidePanelOpen: true } : { sidePanelOverlayOpen: true, sidebarOverlayOpen: false }

const hidePanel = () =>
  getPanelLayout() === "wide" ? { sidePanelOpen: false, sidePanelExpanded: false } : { sidePanelOverlayOpen: false }

export const useSidePanelExpanded = () => {
  const docked = usePanelLayout() === "wide"
  return useUi((state) => docked && state.sidePanelOpen && state.sidePanelExpanded)
}

let opener: Element | null = null

export const rememberOpener = () => {
  opener = document.activeElement
}

// FIXME: Base UI's own fallback, when the page itself had focus, is whatever an earlier popup was opened from
export const returnFocus = () => {
  if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) return opener
  useUi.getState().requestComposerFocus()
  return false
}

export const useUi = create<UiState>()((set, get) => ({
  sidebarOpen: true,
  sidebarWidth: loadSize(SIDEBAR_WIDTH_KEY, SIDEBAR_BOUNDS) ?? SIDEBAR_DEFAULT_WIDTH,
  sidePanelOpen: true,
  sidebarOverlayOpen: false,
  sidePanelOverlayOpen: false,
  sidebarTab: loadSidebarTab(),
  inboxActivityShown: localStorage.getItem(INBOX_ACTIVITY_KEY) === "true",
  inboxWorkingFolded: localStorage.getItem(WORKING_FOLDED_KEY) === "true",
  pickedPullRequests: {},
  pickPullRequest: (threadId, url) =>
    set((state) => ({ pickedPullRequests: { ...state.pickedPullRequests, [threadId]: url } })),
  pullRequestTab: loadPullRequestTab(),
  linkedPullRequestsOpen: false,
  sidebarQuery: "",
  sidebarProjectIds: loadStrings(SIDEBAR_PROJECTS_KEY),
  collapsedPullRequestSections: loadStrings(COLLAPSED_PULL_REQUEST_SECTIONS_KEY).filter(isPullRequestSection),
  sidePanelViews: {},
  lastSidePanelView: "details",
  sidePanelWidth: loadSize(SIDE_PANEL_WIDTH_KEY, SIDE_PANEL_BOUNDS),
  sidePanelExpanded: false,
  viewFocusRequest: null,
  changesPath: null,
  changesScopes: {},
  setChangesScope: (threadId, scope) =>
    set((state) => ({ changesScopes: { ...state.changesScopes, [threadId]: scope } })),
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
  importSessionProjectId: null,
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
        ? { sidePanelOpen: !state.sidePanelOpen, sidePanelOverlayOpen: false, sidePanelExpanded: false }
        : { sidePanelOverlayOpen: !state.sidePanelOverlayOpen, sidebarOverlayOpen: false },
    ),
  toggleSidePanelExpanded: () => set((state) => ({ sidePanelExpanded: !state.sidePanelExpanded })),
  setSidebarOverlayOpen: (open) =>
    set((state) => ({ sidebarOverlayOpen: open, sidePanelOverlayOpen: open ? false : state.sidePanelOverlayOpen })),
  setSidePanelOverlayOpen: (open) =>
    set((state) => ({ sidePanelOverlayOpen: open, sidebarOverlayOpen: open ? false : state.sidebarOverlayOpen })),
  setInboxActivityShown: (inboxActivityShown) => {
    localStorage.setItem(INBOX_ACTIVITY_KEY, String(inboxActivityShown))
    set({ inboxActivityShown })
  },
  setInboxWorkingFolded: (inboxWorkingFolded) => {
    localStorage.setItem(WORKING_FOLDED_KEY, String(inboxWorkingFolded))
    set({ inboxWorkingFolded })
  },
  setSidebarTab: (sidebarTab) => {
    localStorage.setItem(SIDEBAR_TAB_KEY, sidebarTab)
    set({ sidebarTab })
  },
  setPullRequestTab: (pullRequestTab) => {
    localStorage.setItem(PULL_REQUEST_TAB_KEY, pullRequestTab)
    set({ pullRequestTab })
  },
  setLinkedPullRequestsOpen: (linkedPullRequestsOpen) => set({ linkedPullRequestsOpen }),
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
      lastSidePanelView: view === "browser" ? state.lastSidePanelView : view,
      viewFocusRequest: options?.focus ? view : null,
      ...showPanel(),
    })),
  toggleView: (threadId, view, options) => {
    const state = get()
    if (selectSidePanelShown(state) && selectSidePanelView(threadId)(state) === view) set(hidePanel())
    else state.showView(threadId, view, options)
  },
  clearViewFocusRequest: () => set({ viewFocusRequest: null }),
  setChangesPath: (changesPath) => set({ changesPath }),
  requestComposerFocus: () => set((state) => ({ composerFocusRequest: state.composerFocusRequest + 1 })),
  requestInterrupt: () => set((state) => ({ interruptRequest: state.interruptRequest + 1 })),
  requestPicker: (picker) => {
    rememberOpener()
    set({ pickerRequest: { picker, inSidechat: document.activeElement?.closest("[data-sidechat]") != null } })
  },
  setAddProjectOpen: (addProjectOpen, environment = null) => {
    if (addProjectOpen) rememberOpener()
    set({ addProjectOpen, addProjectEnvironment: environment })
  },
  setResourcesOpen: (resourcesOpen) => set({ resourcesOpen }),
  setSnoozeThreadId: (snoozeThreadId) => {
    if (snoozeThreadId !== null) rememberOpener()
    set({ snoozeThreadId })
  },
  setImportSessionProjectId: (importSessionProjectId) => set({ importSessionProjectId }),
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
  setSidePanelWidth: (width) => {
    const clamped = width === null ? null : clampSize(SIDE_PANEL_BOUNDS, width)
    saveSize(SIDE_PANEL_WIDTH_KEY, clamped)
    set({ sidePanelWidth: clamped })
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
