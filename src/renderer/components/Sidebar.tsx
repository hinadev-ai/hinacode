import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { RiAddLine, RiArrowRightSLine, RiFolderAddLine, RiSettings3Line, RiSideBarLine } from "react-icons/ri"
import type { Project } from "../../shared/domain.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { useUi } from "../stores/ui.ts"
import { AddProjectDialog } from "./AddProjectDialog.tsx"
import { AppMark } from "./AppMark.tsx"
import { ChordKeys } from "./ChordKeys.tsx"
import { NewThreadDialog } from "./NewThreadDialog.tsx"
import { SidebarThreadList } from "./SidebarThreadList.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

/** Stays mounted while hidden so its dialogs, opened by keybindings, still render. */
export function Sidebar() {
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const toggleSidebar = useUi((state) => state.toggleSidebar)
  const addProjectOpen = useUi((state) => state.addProjectOpen)
  const setAddProjectOpen = useUi((state) => state.setAddProjectOpen)
  const keymap = useKeymap()
  const hideChord = keymap["sidebar.toggle"]
  const addChord = keymap["project.add"]

  return (
    <nav
      aria-label={m.sidebar_label()}
      hidden={!sidebarOpen}
      className="flex w-60 shrink-0 flex-col text-sidebar-foreground"
    >
      <header className="mt-1.5 flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <AppMark className="size-5 rounded-[5px] text-[11px]" />
        <span className="mr-auto text-sm font-semibold tracking-tight">{m.app_name()}</span>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={m.sidebar_hide()} onClick={toggleSidebar} />}
          >
            <RiSideBarLine aria-hidden className="text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {m.sidebar_hide()}
            {hideChord && <ChordKeys chord={hideChord} />}
          </TooltipContent>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <ProjectList onAddProject={() => setAddProjectOpen(true)} />
      </ScrollArea>

      <footer className="flex shrink-0 items-center gap-1 px-2 pt-1 pb-2">
        <Link
          to="/settings"
          className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[status=active]:bg-sidebar-accent data-[status=active]:text-foreground"
        >
          <RiSettings3Line aria-hidden className="size-4" />
          {m.sidebar_settings()}
        </Link>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={m.sidebar_add_project()}
                onClick={() => setAddProjectOpen(true)}
              />
            }
          >
            <RiFolderAddLine aria-hidden className="text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent side="top">
            {m.sidebar_add_project()}
            {addChord && <ChordKeys chord={addChord} />}
          </TooltipContent>
        </Tooltip>
      </footer>

      <AddProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} />
    </nav>
  )
}

function ProjectList({ onAddProject }: { onAddProject: () => void }) {
  const projects = useAtomValue(projectsAtom)
  const refresh = useAtomRefresh(projectsAtom)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  return AsyncResult.builder(projects)
    .onInitial(() => <p className="px-4 py-2 text-xs text-muted-foreground">{m.sidebar_loading()}</p>)
    .onSuccess((list) =>
      list.length === 0 ? (
        <div className="flex flex-col items-start gap-1 px-4 py-3">
          <p className="text-sm font-medium">{m.sidebar_empty_title()}</p>
          <p className="text-xs text-pretty text-muted-foreground">{m.sidebar_empty_hint()}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onAddProject}>
            <RiFolderAddLine aria-hidden />
            {m.sidebar_add_project()}
          </Button>
        </div>
      ) : (
        <ul ref={listRef} className="flex flex-col gap-4 px-2 pt-1 pb-3">
          {list.map((project) => (
            <ProjectGroup key={project.id} project={project} />
          ))}
        </ul>
      ),
    )
    .orElse(() => (
      <div role="alert" className="flex flex-col items-start gap-2 px-4 py-2">
        <p className="text-xs text-destructive">{m.sidebar_load_failed()}</p>
        <Button variant="outline" size="xs" onClick={refresh}>
          {m.sidebar_retry()}
        </Button>
      </div>
    ))
}

function ProjectGroup({ project }: { project: Project }) {
  const newThreadOpen = useUi((state) => state.newThreadProjectId === project.id)
  const setNewThreadProjectId = useUi((state) => state.setNewThreadProjectId)
  const setNewThreadOpen = (open: boolean) => setNewThreadProjectId(open ? project.id : null)

  return (
    <li>
      <Collapsible defaultOpen>
        <div className="group/project flex h-7 items-center gap-0.5">
          <CollapsibleTrigger
            className="group/trigger flex h-full min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={m.sidebar_toggle_project({ project: project.name })}
          >
            <span className="truncate" title={project.rootPath}>
              {project.name}
            </span>
            <RiArrowRightSLine
              aria-hidden
              className="size-3.5 shrink-0 opacity-0 transition-[rotate,opacity] duration-150 group-hover/project:opacity-100 group-focus-visible/trigger:opacity-100 group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
            aria-label={m.sidebar_new_thread_in({ project: project.name })}
            onClick={() => setNewThreadOpen(true)}
          >
            <RiAddLine aria-hidden />
          </Button>
        </div>
        <CollapsibleContent>
          <SidebarThreadList projectId={project.id} />
        </CollapsibleContent>
      </Collapsible>
      <NewThreadDialog project={project} open={newThreadOpen} onOpenChange={setNewThreadOpen} />
    </li>
  )
}
