import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useRouter, useNavigate } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { AsyncResult } from "effect/reactivity"
import { type RefObject, useEffect, useRef, useState } from "react"
import {
  RiAddLine,
  RiArrowRightSLine,
  RiFilter3Fill,
  RiFilter3Line,
  RiFolder3Line,
  RiFolderAddLine,
} from "react-icons/ri"
import { useShallow } from "zustand/react/shallow"
import type { Project, Thread } from "../../shared/domain.ts"
import { projectIconAtom, projectsAtom } from "../lib/rpc.ts"
import { loadAllPullRequestsAtom } from "../stores/pullRequests.ts"
import { SIDEBAR_BOUNDS, SIDEBAR_DEFAULT_WIDTH } from "../lib/panelWidth.ts"
import { startThread } from "../lib/startThread.ts"
import { m } from "../paraglide/messages.js"
import { selectArchivedThreads, selectProjectThreads, type ThreadsState, useThreads } from "../stores/threads.ts"
import { type SidebarTab, useUi } from "../stores/ui.ts"
import { ResizeHandle } from "./ResizeHandle.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
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

      <Tabs value={tab} onValueChange={(value: SidebarTab) => setTab(value)} className="min-h-0 flex-1 gap-1">
        <TabsList variant="line" className="w-full justify-start px-2">
          <TabsTrigger value="threads" className="flex-none px-2 text-xs">
            {m.sidebar_tab_threads()}
          </TabsTrigger>
          <TabsTrigger value="archived" className="flex-none px-2 text-xs">
            {m.sidebar_tab_archived()}
          </TabsTrigger>
        </TabsList>
        {(["threads", "archived"] as const).map((value) => (
          <TabsContent key={value} value={value} className="flex min-h-0 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <ProjectList
                tab={value}
                query={query.trim().toLocaleLowerCase()}
                onAddProject={() => setAddProjectOpen(true)}
                focusAfterDelete={addProjectButtonRef}
              />
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>

      <ProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} />
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

/** A project's rows in one tab: all of them when the query matches the project's name, else those whose title matches. */
const tabThreads = (state: Pick<ThreadsState, "byId">, project: Project, tab: SidebarTab, query: Query) => {
  const threads = (tab === "archived" ? selectArchivedThreads : selectProjectThreads)(project.id)(state)
  return query === "" || includes(project.name, query)
    ? threads
    : threads.filter((thread) => includes(thread.title, query))
}

/**
 * The Threads tab with no query lists every project and every active thread. Only this list keeps empty
 * projects, for their new thread button, and only this list can be reordered, since a drop saves every row's position.
 */
const isFullList = (tab: SidebarTab, query: Query) => tab === "threads" && query === ""

/** The projects the filter picks. A filter whose projects are all gone shows every project. */
function useFilteredProjects(projects: ReadonlyArray<Project>) {
  const ids = useUi((state) => state.sidebarProjectIds)
  const picked = projects.filter((project) => ids.includes(project.id))
  return picked.length === 0 ? projects : picked
}

/** The project's own favicon, or a folder when it has none. */
function ProjectIcon({ projectId }: { projectId: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(projectIconAtom(projectId)), () => null)
  return icon === null ? (
    <RiFolder3Line aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <img src={icon} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
  )
}

function ProjectFilterMenu() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const ids = useUi((state) => state.sidebarProjectIds)
  const setIds = useUi((state) => state.setSidebarProjectIds)
  const active = projects.some((project) => ids.includes(project.id))
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
        {projects.map((project) => (
          <DropdownMenuCheckboxItem
            key={project.id}
            checked={ids.includes(project.id)}
            onCheckedChange={(checked) =>
              setIds(checked ? [...ids, project.id] : ids.filter((id) => id !== project.id))
            }
          >
            <ProjectIcon projectId={project.id} />
            <span className="truncate">{project.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ProjectListProps {
  readonly tab: SidebarTab
  readonly query: Query
  readonly onAddProject: () => void
  /** Takes focus after a project is deleted. */
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

function ProjectList({ tab, query, onAddProject, focusAfterDelete }: ProjectListProps) {
  const projects = useAtomValue(projectsAtom)
  const refresh = useAtomRefresh(projectsAtom)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })
  const filtered = useFilteredProjects(AsyncResult.getOrElse(projects, () => []))
  const shownIds = useThreads(
    useShallow((state) =>
      filtered
        .filter((project) => isFullList(tab, query) || tabThreads(state, project, tab, query).length > 0)
        .map((project) => project.id),
    ),
  )
  const shown = filtered.filter((project) => shownIds.includes(project.id))

  return AsyncResult.builder(projects)
    .onInitial(() => <p className="animate-reveal px-3 py-2 text-xs text-muted-foreground">{m.sidebar_loading()}</p>)
    .onSuccess((list) =>
      list.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-3 py-4">
          <p className="text-sm font-medium">{m.sidebar_empty_title()}</p>
          <p className="text-xs text-muted-foreground">{m.sidebar_empty_hint()}</p>
          <Button variant="outline" size="sm" onClick={onAddProject}>
            <RiFolderAddLine aria-hidden />
            {m.sidebar_add_project()}
          </Button>
        </div>
      ) : (
        <ul ref={listRef} className="flex flex-col gap-0.5 px-1.5 pb-3">
          {shown.length === 0 && (
            <li className="px-1.5 py-2 text-xs text-muted-foreground">
              {tab === "archived" && query === "" ? m.sidebar_no_archived() : m.sidebar_no_matches()}
            </li>
          )}
          {shown.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              tab={tab}
              query={query}
              focusAfterDelete={focusAfterDelete}
            />
          ))}
        </ul>
      ),
    )
    .orElse(() => (
      <div role="alert" className="flex flex-col items-start gap-2 px-3 py-2">
        <p className="text-xs text-destructive">{m.sidebar_load_failed()}</p>
        <Button variant="outline" size="xs" onClick={refresh}>
          {m.sidebar_retry()}
        </Button>
      </div>
    ))
}

interface ProjectGroupProps {
  readonly project: Project
  readonly tab: SidebarTab
  readonly query: Query
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

function ProjectGroup({ project, tab, query, focusAfterDelete }: ProjectGroupProps) {
  const navigate = useNavigate()
  const newThread = () => void startThread(project.id, navigate)
  const newThreadButtonRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [open, setOpen] = useState(true)
  const threads: ReadonlyArray<Thread> = useThreads(useShallow((state) => tabThreads(state, project, tab, query)))

  return (
    <li>
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
            className="group/trigger flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={m.sidebar_toggle_project({ project: project.name })}
          >
            <RiArrowRightSLine
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
            />
            <RiFolder3Line aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium" title={project.rootPath}>
              {project.name}
            </span>
          </CollapsibleTrigger>
          <Button
            ref={newThreadButtonRef}
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover/project:opacity-100 group-data-[menu-open=true]/project:opacity-100 focus:opacity-100"
            aria-label={m.sidebar_new_thread_in({ project: project.name })}
            onClick={newThread}
          >
            <RiAddLine aria-hidden />
          </Button>
          <ProjectMenu
            project={project}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onNewThread={newThread}
            focusAfterDelete={focusAfterDelete}
          />
        </div>
        {/* Clips the rows while the height animates, with room left for a row's 2px focus ring. */}
        <CollapsibleContent className="h-(--collapsible-panel-height) overflow-clip transition-[height] [overflow-clip-margin:2px] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
          <SidebarThreadList
            projectId={project.id}
            threads={threads}
            reorderable={isFullList(tab, query)}
            newThreadButtonRef={newThreadButtonRef}
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
