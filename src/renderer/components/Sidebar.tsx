import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import {
  RiAddLine,
  RiArrowRightSLine,
  RiFolder3Line,
  RiFolderAddLine,
  RiGitBranchLine,
  RiSettings3Line,
  RiSideBarFill,
} from "react-icons/ri"
import { useShallow } from "zustand/react/shallow"
import type { Project } from "../../shared/domain.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { selectProjectThreads, useThreads } from "../stores/threads.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { useUi } from "../stores/ui.ts"
import { AddProjectDialog } from "./AddProjectDialog.tsx"
import { ChordKeys } from "./ChordKeys.tsx"
import { NewThreadDialog } from "./NewThreadDialog.tsx"
import { ProviderIcon } from "./ProviderIcon.tsx"
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
  const hideChord = useKeymap()["sidebar.toggle"]

  return (
    <nav
      aria-label={m.sidebar_label()}
      hidden={!sidebarOpen}
      className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <header className="flex h-12 items-center gap-0.5 pr-2 pl-3">
        <span className="mr-auto font-heading text-sm font-semibold">{m.app_name()}</span>
        <Button variant="ghost" size="icon-sm" render={<Link to="/settings" />} aria-label={m.sidebar_settings()}>
          <RiSettings3Line aria-hidden />
        </Button>
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
      </header>

      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-xs font-medium text-muted-foreground">{m.sidebar_projects()}</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={m.sidebar_add_project()}
          onClick={() => setAddProjectOpen(true)}
        >
          <RiFolderAddLine aria-hidden />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ProjectList onAddProject={() => setAddProjectOpen(true)} />
      </ScrollArea>

      <AddProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} />
    </nav>
  )
}

function ProjectList({ onAddProject }: { onAddProject: () => void }) {
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
            <ProjectGroup key={project.id} project={project} />
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

function ProjectGroup({ project }: { project: Project }) {
  const threads = useThreads(useShallow(selectProjectThreads(project.id)))
  const newThreadOpen = useUi((state) => state.newThreadProjectId === project.id)
  const setNewThreadProjectId = useUi((state) => state.setNewThreadProjectId)
  const setNewThreadOpen = (open: boolean) => setNewThreadProjectId(open ? project.id : null)
  const [threadListRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  return (
    <li>
      <Collapsible defaultOpen>
        <div className="group/project flex items-center gap-0.5 rounded-md hover:bg-sidebar-accent">
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
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
            aria-label={m.sidebar_new_thread_in({ project: project.name })}
            onClick={() => setNewThreadOpen(true)}
          >
            <RiAddLine aria-hidden />
          </Button>
        </div>
        <CollapsibleContent>
          <ul ref={threadListRef} className="flex flex-col gap-0.5 py-0.5 pl-5">
            {threads.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">{m.sidebar_no_threads()}</li>
            )}
            {threads.map((thread) => (
              <li key={thread.id}>
                <Link
                  to="/thread/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground"
                >
                  <ProviderIcon provider={thread.provider} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate" title={thread.title}>
                      {thread.title}
                    </span>
                    {thread.worktreeId && <WorktreeBranch worktreeId={thread.worktreeId} />}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
      <NewThreadDialog project={project} open={newThreadOpen} onOpenChange={setNewThreadOpen} />
    </li>
  )
}

function WorktreeBranch({ worktreeId }: { worktreeId: string }) {
  const worktree = useWorktrees((state) => state.byId[worktreeId])
  if (!worktree) return null
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground data-[removed=true]:line-through"
      data-removed={worktree.status === "removed"}
      title={m.sidebar_worktree_branch({ branch: worktree.branch })}
    >
      <RiGitBranchLine aria-hidden className="size-3 shrink-0" />
      <span className="truncate font-mono">{worktree.branch}</span>
    </span>
  )
}
