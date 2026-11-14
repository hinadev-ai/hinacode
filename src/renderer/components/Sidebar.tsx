import { useAutoAnimate } from "@formkit/auto-animate/react"
import { cn } from "../lib/utils.ts"
import { listMotionPausedWhile } from "../lib/listMotion.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link, useRouter, useNavigate } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react"
import { RiInbox2Line, RiPulseLine } from "react-icons/ri"
import { useShallow } from "zustand/react/shallow"
import type { Project, SidebarGroup, Thread } from "../../shared/domain.ts"
import { pickedEnvironmentIds, pickEnvironment } from "../../shared/environmentFilter.ts"
import { environmentName, environmentOf, isStale, statusLabel, useCloud, useClouds } from "../lib/environments.ts"
import {
  filterSidebarProjects,
  hiddenEnvironmentIds,
  type SidebarEnvironment,
  sidebarEnvironments,
} from "../lib/sidebarFilter.ts"
import {
  groupProjects,
  isGroupPicked,
  pickProjectGroup,
  type ProjectGroup as Group,
} from "../../shared/projectGroups.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { arrangeRows, deleteGroup, moveGroup, renameGroup, setGroupCollapsed } from "../lib/sidebarGroups.ts"
import { useSidebarGroups } from "../lib/useSidebarGroups.ts"
import { type InboxGroup, inboxGroup, rowState } from "../../shared/threadStatus.ts"
import { pullRequestAttentionsAtom } from "../lib/rpc.ts"
import { useBackgroundTasks } from "../stores/backgroundTasks.ts"
import { useSending } from "../stores/sending.ts"
import { type Draft, hasContent, useDrafts } from "../stores/drafts.ts"
import { useUnseen } from "../stores/unseen.ts"
import { loadAllPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { SIDEBAR_BOUNDS, SIDEBAR_DEFAULT_WIDTH } from "../lib/panelSize.ts"
import { startThread } from "../lib/startThread.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { NEW_THREAD_PREFIX, usePalette } from "../palette/usePalette.ts"
import {
  lastActivity,
  selectArchivedThreads,
  selectInboxThreads,
  selectPinnedThreads,
  selectProjectThreads,
  selectSnoozedThreads,
  selectProjectListThreads,
  type ThreadsState,
  useThreads,
} from "../stores/threads.ts"
import { returnFocus, type SidebarTab, useUi } from "../stores/ui.ts"
import { CloudMark } from "./CloudMark.tsx"
import { GroupNameDialog } from "./GroupNameDialog.tsx"
import { ResizeHandle } from "./ResizeHandle.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { ProjectIcon } from "./ProjectIcon.tsx"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BoltIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  CloudOffIcon,
  FilterFillIcon,
  FilterIcon,
  FolderAddIcon,
  FolderIcon,
  type IconComponent,
  LaptopIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "@hinacode/icons"
import { ProjectMenu } from "./ProjectMenu.tsx"
import { ChordKeys } from "./ChordKeys.tsx"
import { useAttentionCount } from "./DockBadge.tsx"
import {
  DraftRows,
  ARCHIVED_GROUP,
  READY_GROUP,
  SETTLED_GROUP,
  SidebarThreadList,
  TurnList,
} from "./SidebarThreadList.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import { Dialog, DialogPortal, DialogTitle } from "./ui/dialog.tsx"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx"

export function Sidebar({
  compact,
  replaced,
  finalFocus,
}: {
  compact: boolean
  replaced: boolean
  finalFocus: RefObject<HTMLButtonElement | null>
}) {
  useAtomValue(loadAllPullRequestsAtom)
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const overlayOpen = useUi((state) => state.sidebarOverlayOpen)
  const setOverlayOpen = useUi((state) => state.setSidebarOverlayOpen)
  const addProjectOpen = useUi((state) => state.addProjectOpen)
  const addProjectEnvironment = useUi((state) => state.addProjectEnvironment)
  const setAddProjectOpen = useUi((state) => state.setAddProjectOpen)
  const sidebarWidth = useUi((state) => state.sidebarWidth)
  const tab = useUi((state) => state.sidebarTab)
  const setTab = useUi((state) => state.setSidebarTab)
  const query = useUi((state) => state.sidebarQuery)
  const setQuery = useUi((state) => state.setSidebarQuery)
  const setSidebarWidth = useUi((state) => state.setSidebarWidth)
  const addProjectButtonRef = useRef<HTMLButtonElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const router = useRouter()

  useEffect(() => router.subscribe("onResolved", () => setOverlayOpen(false)), [router, setOverlayOpen])

  const content = (
    <nav
      ref={navRef}
      aria-label={m.sidebar_label()}
      hidden={!compact && (!sidebarOpen || replaced)}
      style={compact ? undefined : { width: sidebarWidth }}
      className={
        compact
          ? "flex min-h-0 w-full flex-1 flex-col bg-sidebar text-sidebar-foreground"
          : "relative flex min-h-0 flex-1 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground glass:bg-sidebar/(--glass-chrome-alpha)"
      }
    >
      <Tabs
        orientation="vertical"
        value={tab}
        onValueChange={(value: SidebarTab) => setTab(value)}
        className="min-h-0 flex-1 flex-col gap-2"
      >
        <div className="flex flex-col gap-1 px-2 pt-1">
          <div className="flex items-center gap-0.5">
            <div className="group/search flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md ps-2.5 pe-1 text-sidebar-foreground focus-within:bg-sidebar-row-hover hover:bg-sidebar-row-hover">
              <SearchIcon aria-hidden className="size-4 shrink-0 text-sidebar-meta" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={m.sidebar_filter_label()}
                placeholder={m.sidebar_search_placeholder()}
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-sidebar-meta [&::-webkit-search-cancel-button]:hidden"
              />
              <SidebarFilterMenu />
            </div>
            <ComposeButton />
          </div>
          <div className="flex flex-col gap-0.5">
            <TabsList
              aria-label={m.sidebar_views()}
              className="w-full flex-col items-stretch gap-0.5 bg-transparent p-0 *:data-[slot=tabs-indicator]:hidden"
            >
              <InboxTabTrigger />
              <SidebarTabTrigger value="threads" icon={ChatIcon} label={m.sidebar_tab_threads()} />
            </TabsList>
            <Link to="/settings" search={{ page: "routines" }} className={cn(sidebarTabClass, "flex items-center")}>
              <BoltIcon aria-hidden className="shrink-0" />
              <span className="truncate">{m.settings_routines()}</span>
            </Link>
          </div>
        </div>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName={tab === "inbox" ? "animate-none! data-has-overflow-y:pe-0" : "data-has-overflow-y:pe-0"}
          scrollbarClassName={quietScrollbar}
        >
          <div className="flex flex-col gap-3 pb-3">
            <PinnedThreads query={query.trim().toLocaleLowerCase()} />
            <TabsContent value="inbox" className="flex flex-col">
              <InboxList query={query.trim().toLocaleLowerCase()} />
            </TabsContent>
            <TabsContent value="threads" className="flex flex-col">
              <SectionHeading
                title={m.sidebar_projects()}
                action={
                  <Button
                    ref={addProjectButtonRef}
                    variant="ghost"
                    size="icon-xs"
                    aria-label={m.sidebar_add_project()}
                    onClick={() => setAddProjectOpen(true)}
                  >
                    <FolderAddIcon aria-hidden />
                  </Button>
                }
              />
              <ProjectList
                query={query.trim().toLocaleLowerCase()}
                onAddProject={() => setAddProjectOpen(true)}
                focusAfterDelete={addProjectButtonRef}
              />
            </TabsContent>
          </div>
        </ScrollArea>
        {tab === "inbox" && <InboxShelves query={query.trim().toLocaleLowerCase()} />}
      </Tabs>

      <ProjectDialog
        open={addProjectOpen}
        onOpenChange={(open) => setAddProjectOpen(open)}
        environment={addProjectEnvironment}
        finalFocus={returnFocus}
      />
      {!compact && sidebarOpen && !replaced && (
        <ResizeHandle
          label={m.sidebar_resize()}
          edge="right"
          targetRef={navRef}
          bounds={SIDEBAR_BOUNDS}
          onResize={setSidebarWidth}
          onReset={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        />
      )}
    </nav>
  )

  if (!compact) return content
  return (
    <Dialog open={overlayOpen} onOpenChange={setOverlayOpen}>
      <DialogPortal keepMounted>
        <DialogPrimitive.Backdrop className="fixed inset-x-0 top-titlebar bottom-0 z-50 bg-background/60" />
        <DialogPrimitive.Popup
          finalFocus={finalFocus}
          className="fixed top-titlebar bottom-0 left-0 z-50 flex w-64 max-w-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar outline-none"
        >
          <DialogTitle className="sr-only">{m.sidebar_label()}</DialogTitle>
          {content}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

type Query = string

const includes = (text: string, query: Query) => text.toLocaleLowerCase().includes(query)

const projectThreads = (state: Pick<ThreadsState, "byId">, projects: ReadonlyArray<Project>, query: Query) =>
  selectProjectListThreads(...projects.map((project) => project.id))(state).filter(
    (thread) =>
      query === "" ||
      includes(thread.title, query) ||
      projects.some((project) => project.id === thread.projectId && includes(project.name, query)),
  )

function useMatchingThreads(select: (state: Pick<ThreadsState, "byId">) => ReadonlyArray<Thread>, query: Query) {
  const projects = useFilteredProjects(AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []))
  return useThreads(
    useShallow((state) =>
      select(state).filter((thread) => {
        const project = projects.find((candidate) => candidate.id === thread.projectId)
        return project !== undefined && (includes(project.name, query) || includes(thread.title, query))
      }),
    ),
  )
}

function PinnedThreads({ query }: { query: Query }) {
  const threads = useMatchingThreads(selectPinnedThreads, query)
  const [open, setOpen] = useState(true)
  if (threads.length === 0) return null
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex flex-col border-b border-sidebar-border pb-3"
      render={<section aria-label={m.sidebar_pinned()} />}
    >
      <CollapsibleTrigger className="group/heading mx-2 flex h-7 items-center gap-0.5 rounded-md px-2.5 text-xs font-medium text-sidebar-meta outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset">
        <h2>{m.sidebar_pinned()}</h2>
        <ChevronDownIcon
          aria-hidden
          className="size-4 -rotate-90 transition-transform group-data-panel-open/heading:rotate-0 motion-reduce:transition-none cjk:translate-y-[-0.04em]"
        />
        <span aria-hidden className="ms-auto font-normal tabular-nums">
          {threads.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarThreadList group="pinned" threads={threads} reorderable={false} showProject className="px-2" />
      </CollapsibleContent>
    </Collapsible>
  )
}

function SectionHeading({
  title,
  count,
  action,
  emphasized = false,
  className = "",
}: {
  title: string
  count?: number
  action?: ReactNode
  emphasized?: boolean
  className?: string
}) {
  return (
    <div className={`mx-2 flex h-7 items-center gap-1.5 px-2.5 ${className}`}>
      <h2 className={`text-xs ${emphasized ? "font-semibold text-sidebar-title" : "font-medium text-sidebar-meta"}`}>
        {title}
      </h2>
      {(action !== undefined || count !== undefined) && (
        <span className="ms-auto flex items-center gap-1.5">
          {action}
          {count !== undefined && <span className="text-xs text-sidebar-meta tabular-nums">{count}</span>}
        </span>
      )}
    </div>
  )
}

const quietScrollbar = "opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100"

function ComposeButton() {
  const chord = useKeymap()["thread.new"]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.command_thread_new()}
            className="me-1"
            onClick={() => usePalette.getState().show(NEW_THREAD_PREFIX)}
          />
        }
      >
        <PlusIcon aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {m.command_thread_new()}
        {chord && <ChordKeys chord={chord} />}
      </TooltipContent>
    </Tooltip>
  )
}

function InboxTabTrigger() {
  const count = useAttentionCount()
  return <SidebarTabTrigger value="inbox" icon={RiInbox2Line} label={m.sidebar_tab_inbox()} count={count} />
}

const sidebarTabClass =
  "h-8 w-full min-w-0 flex-none justify-start gap-2 rounded-md border-0 px-2.5 text-sm font-normal text-sidebar-meta outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring dark:text-sidebar-meta data-active:bg-sidebar-row-selected data-active:font-medium data-active:text-sidebar-foreground dark:data-active:text-sidebar-foreground"

function SidebarTabTrigger({
  value,
  icon: Icon,
  label,
  count = 0,
}: {
  value: SidebarTab
  icon: IconComponent
  label: string
  count?: number
}) {
  return (
    <TabsTrigger value={value} className={sidebarTabClass}>
      <Icon aria-hidden />
      {label}
      {count > 0 && (
        <span aria-hidden className="ms-auto text-xs font-medium tabular-nums">
          {count}
        </span>
      )}
    </TabsTrigger>
  )
}

const draftTitle = (draft: Draft) =>
  draft.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? m.thread_draft_title()

const useDraftTitles = (): Readonly<Record<string, string>> => {
  const draftThreads = useThreads((state) => state.drafts)
  return useDrafts(
    useShallow((state) =>
      Object.fromEntries(
        Object.keys(draftThreads).flatMap((threadId) => {
          const draft = state.byThreadId[threadId]
          return draft && hasContent(draft) ? [[threadId, draftTitle(draft)]] : []
        }),
      ),
    ),
  )
}

const writtenDrafts = (
  threads: ThreadsState["drafts"],
  titles: Readonly<Record<string, string>>,
  projects: ReadonlyArray<Project>,
  query: Query,
) =>
  Object.values(threads)
    .flatMap((thread) => {
      const title = titles[thread.id]
      const project = projects.find((candidate) => candidate.id === thread.projectId)
      if (title === undefined || project === undefined) return []
      return includes(project.name, query) || includes(title, query) ? [{ thread, title }] : []
    })
    .toSorted((a, b) => b.thread.createdAt.localeCompare(a.thread.createdAt))

function useWrittenDrafts(projects: ReadonlyArray<Project>, query: Query) {
  const titles = useDraftTitles()
  const threads = useThreads((state) => state.drafts)
  return writtenDrafts(threads, titles, projects, query)
}

function useInboxGroups(threads: ReadonlyArray<Thread>) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const unseen = useUnseen((state) => state.byThreadId)
  const background = useBackgroundTasks((state) => state.byThreadId)
  const sending = useSending((state) => state.threadIds)
  const links = usePullRequests((state) => state.byThreadId)
  const lookups = threads.map((thread) => {
    const project = projects.find((candidate) => candidate.id === thread.projectId)
    return [environmentOf(project), (links[thread.id] ?? []).map((link) => link.url)] as const
  })
  const attentions = useAtomValue(pullRequestAttentionsAtom(lookups))
  const entries = threads.map((thread, index) => {
    const state = rowState(
      thread.status,
      (background[thread.id]?.length ?? 0) > 0 || sending.has(thread.id),
      unseen[thread.id],
      attentions[index],
    )
    return { thread, group: inboxGroup(state, thread.settledAt) }
  })
  const threadsIn = (group: InboxGroup) => entries.filter((entry) => entry.group === group).map((entry) => entry.thread)
  return {
    ready: threadsIn("ready").toSorted(newestActivityFirst),
    settled: threadsIn("settled"),
  }
}

const newestActivityFirst = (a: Thread, b: Thread) => lastActivity(b).localeCompare(lastActivity(a))

const SHELF_PAGE_SIZE = 50

function InboxShelves({ query }: { query: Query }) {
  const now = useNow()
  const threads = useMatchingThreads(selectInboxThreads(now), query)
  const archived = useMatchingThreads(selectArchivedThreads, query)
  const { settled } = useInboxGroups(threads)
  if (settled.length === 0 && archived.length === 0) return null
  return (
    <div className="flex shrink-0 flex-col border-t border-sidebar-border py-1">
      <Shelf
        title={m.sidebar_settled()}
        group={SETTLED_GROUP}
        threads={settled.toSorted(newestActivityFirst)}
        query={query}
      />
      <Shelf
        title={m.sidebar_archived()}
        group={ARCHIVED_GROUP}
        threads={archived.toSorted(newestActivityFirst)}
        query={query}
      />
    </div>
  )
}

function Shelf({
  title,
  group,
  threads,
  query,
}: {
  title: string
  group: string
  threads: ReadonlyArray<Thread>
  query: Query
}) {
  const [open, setOpen] = useState(false)
  if (threads.length === 0) return null
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex flex-col-reverse"
      render={<section aria-label={title} />}
    >
      <CollapsibleTrigger className="group/heading mx-2 flex h-7 items-center gap-0.5 rounded-md px-2.5 text-xs font-medium text-sidebar-meta outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset">
        <h2>{title}</h2>
        <ChevronDownIcon
          aria-hidden
          className="size-4 rotate-180 transition-transform group-data-panel-open/heading:rotate-0 motion-reduce:transition-none cjk:translate-y-[-0.04em]"
        />
        <span className="ms-auto font-normal tabular-nums">{threads.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-clip transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <ShelfRows key={query} group={group} threads={threads} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function ShelfRows({ group, threads }: { group: string; threads: ReadonlyArray<Thread> }) {
  return (
    <ScrollArea viewportClassName="max-h-[45dvh] data-has-overflow-y:pe-0" scrollbarClassName={quietScrollbar}>
      <SidebarThreadList
        group={group}
        threads={threads}
        reorderable={false}
        showProject
        pageSize={SHELF_PAGE_SIZE}
        className="px-2"
      />
    </ScrollArea>
  )
}

function InboxList({ query }: { query: Query }) {
  const now = useNow()
  const threads = useMatchingThreads(selectInboxThreads(now), query)
  const snoozed = useMatchingThreads(selectSnoozedThreads(now), query)
  const { ready } = useInboxGroups(threads)
  const projects = useFilteredProjects(AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []))
  const drafts = useWrittenDrafts(projects, query)
  const showActivity = useUi((state) => state.inboxActivityShown)
  const setShowActivity = useUi((state) => state.setInboxActivityShown)
  return (
    <>
      <TurnList
        className="px-2"
        sections={[
          ...(drafts.length === 0
            ? []
            : [
                {
                  key: "drafts",
                  group: "drafts",
                  heading: <SectionHeading title={m.sidebar_drafts()} count={drafts.length} />,
                  threads: [],
                  drafts,
                  projectNames: new Map(projects.map((project) => [project.id, project.name])),
                },
              ]),
          {
            key: READY_GROUP,
            divided: drafts.length > 0,
            group: READY_GROUP,
            headingClassName: "sticky top-0 z-20 bg-sidebar",
            heading: (
              <SectionHeading
                title={m.sidebar_ready()}
                count={ready.length}
                emphasized
                action={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={m.sidebar_agents_show_activity()}
                    title={m.sidebar_agents_show_activity()}
                    aria-pressed={showActivity}
                    className="aria-pressed:bg-sidebar-row-selected aria-pressed:text-sidebar-foreground"
                    onClick={() => setShowActivity(!showActivity)}
                  >
                    <RiPulseLine aria-hidden />
                  </Button>
                }
              />
            ),
            threads: ready,
            showActivity,
            flat: true,
            empty: query === "" ? m.sidebar_nothing_ready() : m.sidebar_no_matches(),
          },
        ]}
      />
      {snoozed.length > 0 && (
        <section aria-label={m.sidebar_snoozed()} className="mt-3 border-t border-sidebar-border pt-3">
          <SectionHeading title={m.sidebar_snoozed()} count={snoozed.length} />
          <SidebarThreadList group="snoozed" threads={snoozed} reorderable={false} showProject className="px-2" />
        </section>
      )}
    </>
  )
}

const isFullList = (query: Query) => query === ""

function useHiddenEnvironments(projects: ReadonlyArray<Project>) {
  const environments = sidebarEnvironments(projects, useClouds())
  const filter = useUi((state) => state.sidebarEnvironmentFilter)
  return { environments, hidden: hiddenEnvironmentIds(environments, filter) }
}

function useFilteredProjects(projects: ReadonlyArray<Project>) {
  const { hidden } = useHiddenEnvironments(projects)
  const ids = useUi((state) => state.sidebarProjectIds)
  return filterSidebarProjects(projects, hidden, ids)
}

function SidebarFilterMenu() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const { environments, hidden } = useHiddenEnvironments(projects)
  const ids = useUi((state) => state.sidebarProjectIds)
  const setIds = useUi((state) => state.setSidebarProjectIds)
  const picked = new Set(ids)
  const shownGroups = groupProjects(projects).filter((group) =>
    group.projects.some((project) => !hidden.has(environmentOf(project))),
  )
  const projectsPicked = shownGroups.some((group) => group.projects.some((project) => picked.has(project.id)))
  const active = hidden.size > 0 || projectsPicked
  const Icon = active ? FilterFillIcon : FilterIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.sidebar_filter_menu()}
            data-active={active}
            className="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
          />
        }
      >
        <Icon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {environments.length > 1 && <EnvironmentFilterItems environments={environments} />}
        <DropdownMenuGroup>
          {environments.length > 1 && <DropdownMenuLabel>{m.sidebar_projects()}</DropdownMenuLabel>}
          <DropdownMenuItem disabled={!projectsPicked} onClick={() => setIds([])}>
            {m.sidebar_filter_all_projects()}
          </DropdownMenuItem>
          {environments.length <= 1 && <DropdownMenuSeparator />}
          {shownGroups.map((group) => (
            <DropdownMenuCheckboxItem
              key={group.key}
              checked={isGroupPicked(group, ids)}
              onCheckedChange={(checked) => setIds(pickProjectGroup(ids, group, checked))}
            >
              <ProjectIcon projectId={group.projects[0].id} />
              <span className="truncate">{group.projects[0].name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EnvironmentFilterItems({ environments }: { environments: ReadonlyArray<SidebarEnvironment> }) {
  const clouds = useClouds()
  const filter = useUi((state) => state.sidebarEnvironmentFilter)
  const setFilter = useUi((state) => state.setSidebarEnvironmentFilter)
  const picked = pickedEnvironmentIds(filter, environments)
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>{m.sidebar_filter_environments()}</DropdownMenuLabel>
        <DropdownMenuItem disabled={picked.size === 0} onClick={() => setFilter({ ...filter, environmentIds: [] })}>
          {m.sidebar_filter_all_environments()}
        </DropdownMenuItem>
        {environments.map(({ id, cloud }) => {
          const EnvironmentIcon =
            cloud === undefined ? LaptopIcon : cloud.status === "connected" ? CloudIcon : CloudOffIcon
          return (
            <DropdownMenuCheckboxItem
              key={id ?? ""}
              checked={picked.has(id)}
              onCheckedChange={(checked) => setFilter(pickEnvironment(filter, id, checked))}
            >
              <EnvironmentIcon aria-hidden className="text-muted-foreground" />
              <span className="truncate">{environmentName(id, clouds)}</span>
              {cloud !== undefined && cloud.status !== "connected" && (
                <span className="ms-auto shrink-0 text-xs text-muted-foreground">{statusLabel[cloud.status]()}</span>
              )}
            </DropdownMenuCheckboxItem>
          )
        })}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={filter.hideOffline}
        onCheckedChange={(hideOffline) => setFilter({ ...filter, hideOffline })}
      >
        {m.sidebar_filter_hide_offline()}
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
    </>
  )
}

interface ProjectListProps {
  readonly query: Query
  readonly onAddProject: () => void
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

const projectListMotion = listMotionPausedWhile(() => useUi.getState().sidebarQuery !== "")

function ProjectList({ query, onAddProject, focusAfterDelete }: ProjectListProps) {
  const projects = useAtomValue(projectsAtom)
  const refresh = useAtomRefresh(projectsAtom)
  const [listRef] = useAutoAnimate<HTMLUListElement>(projectListMotion)
  const groups = groupProjects(useFilteredProjects(AsyncResult.getOrElse(projects, () => [])))
  const draftTitles = useDraftTitles()
  const shownKeys = useThreads(
    useShallow((state) =>
      groups
        .filter(
          (group) =>
            isFullList(query) ||
            projectThreads(state, group.projects, query).length > 0 ||
            writtenDrafts(state.drafts, draftTitles, group.projects, query).length > 0,
        )
        .map((group) => group.key),
    ),
  )
  const shown = groups.filter((group) => shownKeys.includes(group.key))
  const [sidebarGroups] = useSidebarGroups()
  const { grouped, ungrouped } = arrangeRows(shown, sidebarGroups)
  const projectRow = (group: Group, nested = false) => (
    <ProjectGroup key={group.key} group={group} query={query} nested={nested} focusAfterDelete={focusAfterDelete} />
  )
  const groupItems = (group: SidebarGroup, rows: ReadonlyArray<Group>) => {
    const open = !group.collapsed || query !== ""
    const header = <GroupHeader key={group.id} group={group} open={open} />
    if (!open) return [header]
    if (rows.length === 0) {
      return [
        header,
        <li key={`${group.id}-empty`} className="px-3.5 py-1 text-xs text-muted-foreground">
          {m.sidebar_group_empty()}
        </li>,
      ]
    }
    return [header, ...rows.map((row) => projectRow(row, true))]
  }
  const items = [
    ...grouped
      .filter(({ rows }) => isFullList(query) || rows.length > 0)
      .flatMap(({ group, rows }) => groupItems(group, rows)),
    ...ungrouped.map((row) => projectRow(row)),
  ]

  return AsyncResult.builder(projects)
    .onInitial(() => <p className="animate-reveal px-3 py-2 text-xs text-muted-foreground">{m.sidebar_loading()}</p>)
    .onSuccess((list) => (
      <>
        {list.every((project) => project.kind === "chats") && (
          <div className="flex flex-col items-start gap-2 px-3 py-4">
            <p className="text-sm font-medium">{m.sidebar_empty_title()}</p>
            <p className="text-xs text-muted-foreground">{m.sidebar_empty_hint()}</p>
            <Button variant="outline" size="sm" onClick={onAddProject}>
              <FolderAddIcon aria-hidden />
              {m.sidebar_add_project()}
            </Button>
          </div>
        )}
        <ul ref={listRef} className="flex flex-col gap-0.5 px-2">
          {shown.length === 0 && (
            <li className="px-1.5 py-2 text-xs text-muted-foreground">{m.sidebar_no_matches()}</li>
          )}
          {items}
        </ul>
      </>
    ))
    .orElse(() => (
      <div role="alert" className="flex flex-col items-start gap-2 px-3 py-2">
        <p className="text-xs text-destructive">{m.sidebar_load_failed()}</p>
        <Button variant="outline" size="xs" onClick={refresh}>
          {m.sidebar_retry()}
        </Button>
      </div>
    ))
}

interface GroupHeaderProps {
  readonly group: SidebarGroup
  readonly open: boolean
}

function GroupHeader({ group, open }: GroupHeaderProps) {
  const [, update] = useSidebarGroups()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <li className="pt-1">
      <div
        data-menu-open={menuOpen}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuOpen(true)
        }}
        className="group/sidebar-group flex items-center gap-0.5 rounded-md"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={m.sidebar_group_toggle({ group: group.name })}
          // oxlint-disable-next-line hinacode/no-async-on-click
          onClick={() => void update((state) => setGroupCollapsed(state, group.id, open))}
          className="group/trigger flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className="size-4 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90 motion-reduce:transition-none"
          />
          <span className="truncate" title={group.name}>
            {group.name}
          </span>
        </button>
        <GroupMenu group={group} open={menuOpen} onOpenChange={setMenuOpen} />
      </div>
    </li>
  )
}

interface GroupMenuProps {
  readonly group: SidebarGroup
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function GroupMenu({ group, open, onOpenChange }: GroupMenuProps) {
  const [state, update] = useSidebarGroups()
  const index = state.groups.findIndex((candidate) => candidate.id === group.id)
  const [renaming, setRenaming] = useState(false)
  const [renameQueued, setRenameQueued] = useState(false)

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(menuOpen) => {
          if (menuOpen || !renameQueued) return
          setRenaming(true)
          setRenameQueued(false)
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover/sidebar-group:opacity-100 group-data-[menu-open=true]/sidebar-group:opacity-100 focus:opacity-100"
              aria-label={m.sidebar_group_actions({ group: group.name })}
            />
          }
        >
          <MoreIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => setRenameQueued(true)}>
            <PencilIcon aria-hidden />
            {m.sidebar_group_rename()}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index <= 0} onClick={() => void update((next) => moveGroup(next, group.id, -1))}>
            <ArrowUpIcon aria-hidden />
            {m.sidebar_group_move_up()}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === state.groups.length - 1}
            onClick={() => void update((next) => moveGroup(next, group.id, 1))}
          >
            <ArrowDownIcon aria-hidden />
            {m.sidebar_group_move_down()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void update((next) => deleteGroup(next, group.id))}>
            <TrashIcon aria-hidden />
            {m.sidebar_group_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <GroupNameDialog
        name={group.name}
        open={renaming}
        onOpenChange={setRenaming}
        onSubmit={(name) => void update((next) => renameGroup(next, group.id, name))}
      />
    </>
  )
}

interface ProjectGroupProps {
  readonly group: Group
  readonly query: Query
  readonly nested: boolean
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

function ProjectGroup({ group, query, nested, focusAfterDelete }: ProjectGroupProps) {
  const { projects } = group
  const [first] = projects
  const navigate = useNavigate()
  const newThread = (project: Project) => void startThread(project, navigate)
  const newThreadButtonRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [open, setOpen] = useState(true)
  const threads: ReadonlyArray<Thread> = useThreads(useShallow((state) => projectThreads(state, projects, query)))
  const hasActiveThreads = useThreads(
    (state) => selectProjectThreads(...projects.map((project) => project.id))(state).length > 0,
  )
  const drafts = useWrittenDrafts(projects, query)
  const cloud = useCloud(environmentOf(first))
  const cloudMarkId = useId()

  return (
    <li className={nested ? "pl-2" : undefined}>
      <Collapsible open={open || query !== ""} onOpenChange={setOpen}>
        <div
          data-menu-open={menuOpen}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
          className="group/project flex items-center gap-0.5 rounded-md hover:bg-sidebar-accent data-[menu-open=true]:bg-sidebar-accent"
        >
          <CollapsibleTrigger
            data-stale={isStale(cloud)}
            className="group/trigger flex min-w-0 flex-1 items-center gap-1.5 rounded-md p-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[stale=true]:text-muted-foreground"
            aria-label={m.sidebar_toggle_project({ project: first.name })}
            aria-describedby={cloud && cloudMarkId}
          >
            <ChevronRightIcon
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
            />
            {cloud ? (
              <CloudMark cloud={cloud} id={cloudMarkId} className="size-4" />
            ) : first.kind === "chats" ? (
              <ChatIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium" title={first.rootPath}>
              {first.name}
            </span>
          </CollapsibleTrigger>
          <NewThreadButton projects={projects} buttonRef={newThreadButtonRef} onNewThread={newThread} />
          {first.kind === "folder" && (
            <ProjectMenu
              rowKey={group.key}
              projects={projects}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              onNewThread={newThread}
              focusAfterDelete={focusAfterDelete}
            />
          )}
        </div>
        <CollapsibleContent className="h-(--collapsible-panel-height) overflow-clip transition-[height] duration-200 ease-out [overflow-clip-margin:2px] data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
          <SidebarThreadList
            group={group.key}
            threads={threads}
            reorderable={isFullList(query)}
            showEmptyHint={isFullList(query) && !hasActiveThreads && drafts.length === 0}
            newThreadButtonRef={newThreadButtonRef}
            className="pl-5.5"
          />
          {drafts.length > 0 && <DraftRows drafts={drafts} className="pl-5.5" />}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

interface NewThreadButtonProps {
  readonly projects: Group["projects"]
  readonly buttonRef: RefObject<HTMLButtonElement | null>
  readonly onNewThread: (project: Project) => void
}

function NewThreadButton({ projects, buttonRef, onNewThread }: NewThreadButtonProps) {
  const clouds = useClouds()
  const project =
    projects.find((member) => !isStale(clouds.find((cloud) => cloud.id === environmentOf(member)))) ?? projects[0]
  return (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="icon-xs"
      className="opacity-0 group-hover/project:opacity-100 group-data-[menu-open=true]/project:opacity-100 focus:opacity-100"
      aria-label={m.sidebar_new_thread_in({ project: project.name })}
      onClick={() => onNewThread(project)}
    >
      <PlusIcon aria-hidden />
    </Button>
  )
}
