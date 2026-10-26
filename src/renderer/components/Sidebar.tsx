import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useRouter, useNavigate } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { AsyncResult } from "effect/reactivity"
import { type RefObject, useEffect, useId, useRef, useState } from "react"
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiChat3Line,
  RiChatNewLine,
  RiDeleteBinLine,
  RiFilter3Fill,
  RiFilter3Line,
  RiFolder3Line,
  RiFolderAddLine,
  RiMoreFill,
  RiPencilLine,
} from "react-icons/ri"
import { useShallow } from "zustand/react/shallow"
import type { Project, SidebarGroup, Thread } from "../../shared/domain.ts"
import { environmentOf, isStale, useCloud, useClouds } from "../lib/environments.ts"
import { groupProjects, type ProjectGroup as Group } from "../lib/projectGroups.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { arrangeRows, deleteGroup, moveGroup, renameGroup, setGroupCollapsed } from "../lib/sidebarGroups.ts"
import { useSidebarGroups } from "../lib/useSidebarGroups.ts"
import { loadAllPullRequestsAtom } from "../stores/pullRequests.ts"
import { SIDEBAR_BOUNDS, SIDEBAR_DEFAULT_WIDTH } from "../lib/panelSize.ts"
import { startThread } from "../lib/startThread.ts"
import { m } from "../paraglide/messages.js"
import {
  selectArchivedThreads,
  selectInboxThreads,
  selectPinnedThreads,
  selectProjectThreads,
  selectUnpinnedProjectThreads,
  type ThreadsState,
  useThreads,
} from "../stores/threads.ts"
import { type SidebarTab, useUi } from "../stores/ui.ts"
import { CloudMark } from "./CloudMark.tsx"
import { GroupNameDialog } from "./GroupNameDialog.tsx"
import { ResizeHandle } from "./ResizeHandle.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { ProjectIcon } from "./ProjectIcon.tsx"
import { ProjectMenu } from "./ProjectMenu.tsx"
import { SidebarThreadList } from "./SidebarThreadList.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import { Dialog, DialogPortal, DialogTitle } from "./ui/dialog.tsx"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { Input } from "./ui/input.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx"

/** Stays mounted while hidden so its dialogs, opened by keybindings, still render. */
export function Sidebar({
  compact,
  finalFocus,
}: {
  compact: boolean
  finalFocus: RefObject<HTMLButtonElement | null>
}) {
  // Loads every thread's pull request links once, for the PR numbers under each row.
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
      hidden={!compact && !sidebarOpen}
      style={compact ? undefined : { width: sidebarWidth }}
      className={
        compact
          ? "flex min-h-0 w-full flex-1 flex-col bg-sidebar text-sidebar-foreground"
          : "relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      }
    >
      <div className="flex items-center gap-0.5 px-2 pt-2 pb-1">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={m.sidebar_filter_label()}
          placeholder={m.sidebar_filter_placeholder()}
          className="mr-1 h-7 min-w-0 flex-1 text-sm"
        />
        <ProjectFilterMenu />
        <NewChatButton />
        <Button
          ref={addProjectButtonRef}
          variant="ghost"
          size="icon-xs"
          aria-label={m.sidebar_add_project()}
          onClick={() => setAddProjectOpen(true)}
        >
          <RiFolderAddLine aria-hidden />
        </Button>
      </div>

      <PinnedThreads query={query.trim().toLocaleLowerCase()} />

      <Tabs value={tab} onValueChange={(value: SidebarTab) => setTab(value)} className="min-h-0 flex-1 gap-1">
        <TabsList variant="line" className="w-full justify-start px-2">
          <TabsTrigger value="inbox" className="flex-none px-2 text-xs">
            {m.sidebar_tab_inbox()}
          </TabsTrigger>
          <TabsTrigger value="threads" className="flex-none px-2 text-xs">
            {m.sidebar_tab_threads()}
          </TabsTrigger>
          <TabsTrigger value="archived" className="flex-none px-2 text-xs">
            {m.sidebar_tab_archived()}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <InboxList query={query.trim().toLocaleLowerCase()} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="threads" className="flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <ProjectList
              query={query.trim().toLocaleLowerCase()}
              onAddProject={() => setAddProjectOpen(true)}
              focusAfterDelete={addProjectButtonRef}
            />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="archived" className="flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <ArchivedList query={query.trim().toLocaleLowerCase()} />
          </ScrollArea>
        </TabsContent>
      </Tabs>

      <ProjectDialog
        open={addProjectOpen}
        onOpenChange={(open) => setAddProjectOpen(open)}
        environment={addProjectEnvironment}
      />
      {!compact && sidebarOpen && (
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

/** Lowercased and trimmed, or empty for no filter. */
type Query = string

const includes = (text: string, query: Query) => text.toLocaleLowerCase().includes(query)

/** The projects' unpinned active threads whose title or project name matches the query. */
const projectThreads = (state: Pick<ThreadsState, "byId">, projects: ReadonlyArray<Project>, query: Query) =>
  selectUnpinnedProjectThreads(...projects.map((project) => project.id))(state).filter(
    (thread) =>
      query === "" ||
      includes(thread.title, query) ||
      projects.some((project) => project.id === thread.projectId && includes(project.name, query)),
  )

/** Threads of the filtered projects whose title or project name matches the query. */
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

/** Pinned threads of every project, above the tabs so they stay in reach whichever tab is open. */
function PinnedThreads({ query }: { query: Query }) {
  const threads = useMatchingThreads(selectPinnedThreads, query)
  if (threads.length === 0) return null
  return (
    <section
      aria-label={m.sidebar_pinned()}
      className="flex max-h-1/3 shrink-0 flex-col border-b border-sidebar-border pb-1"
    >
      <h2 className="px-3.5 pt-1 text-xs font-medium text-muted-foreground">{m.sidebar_pinned()}</h2>
      <ScrollArea className="min-h-0">
        <SidebarThreadList group="pinned" threads={threads} reorderable={false} showProject className="px-1.5" />
      </ScrollArea>
    </section>
  )
}

/** Active threads of every project in one list, the most recently updated on top. */
function InboxList({ query }: { query: Query }) {
  const threads = useMatchingThreads(selectInboxThreads, query)
  return threads.length === 0 ? (
    <p className="px-3 py-2 text-xs text-muted-foreground">
      {query === "" ? m.sidebar_no_inbox() : m.sidebar_no_matches()}
    </p>
  ) : (
    <SidebarThreadList group="inbox" threads={threads} reorderable={false} showProject className="px-1.5 pb-3" />
  )
}

/** Archived threads of every project in one list, the most recently updated on top. */
function ArchivedList({ query }: { query: Query }) {
  const threads = useMatchingThreads(selectArchivedThreads, query)
  return threads.length === 0 ? (
    <p className="px-3 py-2 text-xs text-muted-foreground">
      {query === "" ? m.sidebar_no_archived() : m.sidebar_no_matches()}
    </p>
  ) : (
    <SidebarThreadList group="archived" threads={threads} reorderable={false} showProject className="px-1.5 pb-3" />
  )
}

/**
 * With no query the Threads tab lists every project and every active thread. Only then does it keep empty
 * projects, for their new thread button, and only then can it be reordered, since a drop saves every row's position.
 */
const isFullList = (query: Query) => query === ""

/** The projects the filter picks. A filter whose projects are all gone shows every project. */
function useFilteredProjects(projects: ReadonlyArray<Project>) {
  const ids = useUi((state) => state.sidebarProjectIds)
  const picked = projects.filter((project) => ids.includes(project.id))
  return picked.length === 0 ? projects : picked
}

function ProjectFilterMenu() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const ids = useUi((state) => state.sidebarProjectIds)
  const setIds = useUi((state) => state.setSidebarProjectIds)
  const picked = new Set(ids)
  const active = projects.some((project) => picked.has(project.id))
  const Icon = active ? RiFilter3Fill : RiFilter3Line

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.sidebar_filter_projects()}
            data-active={active}
            className="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
          />
        }
      >
        <Icon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem disabled={!active} onClick={() => setIds([])}>
          {m.sidebar_filter_all_projects()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {groupProjects(projects).map((group) => {
          const members = new Set(group.projects.map((project) => project.id))
          return (
            <DropdownMenuCheckboxItem
              key={group.key}
              checked={[...members].every((id) => picked.has(id))}
              onCheckedChange={(checked) => {
                const others = ids.filter((id) => !members.has(id))
                setIds(checked ? [...others, ...members] : others)
              }}
            >
              <ProjectIcon projectId={group.projects[0].id} />
              <span className="truncate">{group.projects[0].name}</span>
            </DropdownMenuCheckboxItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ProjectListProps {
  readonly query: Query
  readonly onAddProject: () => void
  /** Takes focus after a project is deleted. */
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

function ProjectList({ query, onAddProject, focusAfterDelete }: ProjectListProps) {
  const projects = useAtomValue(projectsAtom)
  const refresh = useAtomRefresh(projectsAtom)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })
  // Grouped before the query narrows anything, so a search never splits a group or changes its header.
  const groups = groupProjects(useFilteredProjects(AsyncResult.getOrElse(projects, () => [])))
  const shownKeys = useThreads(
    useShallow((state) =>
      groups
        .filter((group) => isFullList(query) || projectThreads(state, group.projects, query).length > 0)
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
  // One array, so a row moved between groups keeps its key in the same list and stays mounted with its focus.
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
              <RiFolderAddLine aria-hidden />
              {m.sidebar_add_project()}
            </Button>
          </div>
        )}
        <ul ref={listRef} className="flex flex-col gap-0.5 px-1.5 pb-3">
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
          onClick={() => void update((state) => setGroupCollapsed(state, group.id, open))}
          className="group/trigger flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <RiArrowRightSLine
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
  // Rename opens its dialog once the menu has closed and handed focus back to the trigger.
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
          <RiMoreFill aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => setRenameQueued(true)}>
            <RiPencilLine aria-hidden />
            {m.sidebar_group_rename()}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index <= 0} onClick={() => void update((next) => moveGroup(next, group.id, -1))}>
            <RiArrowUpLine aria-hidden />
            {m.sidebar_group_move_up()}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === state.groups.length - 1}
            onClick={() => void update((next) => moveGroup(next, group.id, 1))}
          >
            <RiArrowDownLine aria-hidden />
            {m.sidebar_group_move_down()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void update((next) => deleteGroup(next, group.id))}>
            <RiDeleteBinLine aria-hidden />
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
  const newThread = (project: Project) => void startThread(project.id, navigate)
  const newThreadButtonRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [open, setOpen] = useState(true)
  const threads: ReadonlyArray<Thread> = useThreads(useShallow((state) => projectThreads(state, projects, query)))
  // A project whose active threads are all pinned is not empty, they are listed above the tabs.
  const hasActiveThreads = useThreads(
    (state) => selectProjectThreads(...projects.map((project) => project.id))(state).length > 0,
  )
  const cloud = useCloud(environmentOf(first))
  const cloudMarkId = useId()

  return (
    <li className={nested ? "pl-2" : undefined}>
      {/* A query opens every project, so a match is never hidden in a collapsed one. */}
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
            className="group/trigger flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[stale=true]:text-muted-foreground"
            aria-label={m.sidebar_toggle_project({ project: first.name })}
            aria-describedby={cloud && cloudMarkId}
          >
            <RiArrowRightSLine
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
            />
            {cloud ? (
              <CloudMark cloud={cloud} id={cloudMarkId} className="size-4" />
            ) : first.kind === "chats" ? (
              <RiChat3Line aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <RiFolder3Line aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
        {/* Clips the rows while the height animates, with room left for a row's 2px focus ring. */}
        <CollapsibleContent className="h-(--collapsible-panel-height) overflow-clip transition-[height] [overflow-clip-margin:2px] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
          <SidebarThreadList
            group={group.key}
            threads={threads}
            reorderable={isFullList(query)}
            showEmptyHint={isFullList(query) && !hasActiveThreads}
            newThreadButtonRef={newThreadButtonRef}
          />
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
      <RiAddLine aria-hidden />
    </Button>
  )
}

/** Starts a thread in this machine's chats project, which needs no repository. */
function NewChatButton() {
  const navigate = useNavigate()
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const chats = projects.find((project) => project.kind === "chats" && project.environmentId === undefined)
  if (chats === undefined) return null
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={m.sidebar_new_chat()}
      onClick={() => void startThread(chats.id, navigate)}
    >
      <RiChatNewLine aria-hidden />
    </Button>
  )
}
