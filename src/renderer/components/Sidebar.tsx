import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link, useRouter, useNavigate } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { AsyncResult } from "effect/reactivity"
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react"
import {
  RiAddLine,
  RiArrowRightSLine,
  RiFolder3Line,
  RiFolderAddLine,
  RiSettings3Line,
  RiSideBarFill,
} from "react-icons/ri"
import type { Project } from "../../shared/domain.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { loadAllPullRequestsAtom } from "../stores/pullRequests.ts"
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, clampSidebarWidth } from "../lib/sidebarWidth.ts"
import { startThread } from "../lib/startThread.ts"
import { m } from "../paraglide/messages.js"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { useUi } from "../stores/ui.ts"
import { ChordKeys } from "./ChordKeys.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { ProjectMenu } from "./ProjectMenu.tsx"
import { SidebarThreadList } from "./SidebarThreadList.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import { Dialog, DialogPortal, DialogTitle } from "./ui/dialog.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

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
  const toggleSidebar = useUi((state) => state.toggleSidebar)
  const addProjectOpen = useUi((state) => state.addProjectOpen)
  const setAddProjectOpen = useUi((state) => state.setAddProjectOpen)
  const hideChord = useKeymap()["sidebar.toggle"]
  const sidebarWidth = useUi((state) => state.sidebarWidth)
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
      <header className="flex h-12 shrink-0 items-center gap-0.5 pr-2 pl-3">
        <span className="mr-auto min-w-0 truncate font-heading text-sm font-semibold">{m.app_name()}</span>
        <Button variant="ghost" size="icon-sm" render={<Link to="/settings" />} aria-label={m.sidebar_settings()}>
          <RiSettings3Line aria-hidden />
        </Button>
        {compact ? (
          <DialogPrimitive.Close
            render={<Button variant="ghost" size="icon-sm" aria-label={m.sidebar_hide()} title={m.sidebar_hide()} />}
          >
            <RiSideBarFill aria-hidden />
          </DialogPrimitive.Close>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={m.sidebar_hide()} onClick={toggleSidebar} />}
            >
              <RiSideBarFill aria-hidden />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {m.sidebar_hide()}
              {hideChord && <ChordKeys chord={hideChord} />}
            </TooltipContent>
          </Tooltip>
        )}
      </header>

      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-xs font-medium text-muted-foreground">{m.sidebar_projects()}</h2>
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

      <ScrollArea className="min-h-0 flex-1">
        <ProjectList onAddProject={() => setAddProjectOpen(true)} focusAfterDelete={addProjectButtonRef} />
      </ScrollArea>

      <ProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} />
      {!compact && sidebarOpen && <SidebarResizeHandle navRef={navRef} />}
    </nav>
  )

  if (!compact) return content
  return (
    <Dialog open={overlayOpen} onOpenChange={setOverlayOpen}>
      <DialogPortal keepMounted>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background/60" />
        <DialogPrimitive.Popup
          finalFocus={finalFocus}
          className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar outline-none"
        >
          <DialogTitle className="sr-only">{m.sidebar_label()}</DialogTitle>
          {content}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

const KEYBOARD_STEP = 16

function SidebarResizeHandle({ navRef }: { navRef: RefObject<HTMLElement | null> }) {
  const width = useUi((state) => state.sidebarWidth)
  const setWidth = useUi((state) => state.setSidebarWidth)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null)

  const endDrag = () => {
    const current = drag.current
    if (!current) return
    drag.current = null
    setDragging(false)
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    setWidth(current.width)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width, width }
    setDragging(true)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  // Writes straight to the DOM so a drag doesn't re-render the whole sidebar on every move.
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || !navRef.current) return
    current.width = clampSidebarWidth(current.startWidth + event.clientX - current.startX)
    navRef.current.style.width = `${current.width}px`
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = {
      ArrowLeft: width - KEYBOARD_STEP,
      ArrowRight: width + KEYBOARD_STEP,
      Home: SIDEBAR_MIN_WIDTH,
      End: SIDEBAR_MAX_WIDTH,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    setWidth(next)
  }

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable splitter is a widget, and <hr> is void so it can't hold the hover line
      role="separator"
      aria-orientation="vertical"
      aria-label={m.sidebar_resize()}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
      className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none"
    >
      <div
        aria-hidden
        className="mx-auto h-full w-0.5 bg-sidebar-ring opacity-0 transition-opacity duration-100 ease-(--ease-out) group-hover:opacity-100 group-focus-visible:opacity-100 group-data-dragging:opacity-100 motion-reduce:transition-none"
      />
    </div>
  )
}

interface ProjectListProps {
  readonly onAddProject: () => void
  /** Takes focus after a project is deleted. */
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

function ProjectList({ onAddProject, focusAfterDelete }: ProjectListProps) {
  const projects = useAtomValue(projectsAtom)
  const refresh = useAtomRefresh(projectsAtom)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  return AsyncResult.builder(projects)
    .onInitial(() => <p className="px-3 py-2 text-xs text-muted-foreground">{m.sidebar_loading()}</p>)
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
          {list.map((project) => (
            <ProjectGroup key={project.id} project={project} focusAfterDelete={focusAfterDelete} />
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
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

function ProjectGroup({ project, focusAfterDelete }: ProjectGroupProps) {
  const navigate = useNavigate()
  const newThread = () => void startThread(project.id, navigate)
  const newThreadButtonRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <li>
      <Collapsible defaultOpen>
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
        <CollapsibleContent>
          <SidebarThreadList projectId={project.id} newThreadButtonRef={newThreadButtonRef} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
