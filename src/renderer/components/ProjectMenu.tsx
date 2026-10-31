import { Fragment, type RefObject, useState } from "react"
import {
  RiAddLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFolderSharedLine,
  RiInboxArchiveLine,
  RiMoreFill,
  RiPencilLine,
} from "react-icons/ri"
import type { Project } from "../../shared/domain.ts"
import { environmentName, environmentOf, useClouds } from "../lib/environments.ts"
import { assignGroup, createGroup } from "../lib/sidebarGroups.ts"
import { useSidebarGroups } from "../lib/useSidebarGroups.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { DeleteProjectDialog } from "./DeleteProjectDialog.tsx"
import { GroupNameDialog } from "./GroupNameDialog.tsx"
import { OpenWithSubmenu } from "./OpenWith.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { Button } from "./ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"

type Action = "edit" | "newThread" | "importSession" | "delete"

interface Picked {
  readonly action: Action
  readonly project: Project
}

type Queued = Picked | { readonly action: "newGroup" }

interface ProjectMenuProps {
  readonly rowKey: string
  readonly projects: readonly [Project, ...Array<Project>]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onNewThread: (project: Project) => void
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

export function ProjectMenu({ rowKey, projects, open, onOpenChange, onNewThread, focusAfterDelete }: ProjectMenuProps) {
  const clouds = useClouds()
  const [, updateGroups] = useSidebarGroups()
  const [dialog, setDialog] = useState<Queued | null>(null)
  const [queued, setQueued] = useState<Queued | null>(null)

  const runQueued = () => {
    if (queued?.action === "newThread") onNewThread(queued.project)
    else if (queued?.action === "importSession") useUi.getState().setImportSessionProjectId(queued.project.id)
    else setDialog(queued)
    setQueued(null)
  }
  const closeDialog = (dialogOpen: boolean) => {
    if (!dialogOpen) setDialog(null)
  }
  const picked = dialog?.action === "newGroup" ? null : dialog
  const isOpen = (action: Action, project: Project) => picked?.action === action && picked.project.id === project.id
  const newGroup = (name: string) =>
    void updateGroups((state) => createGroup(state, { id: crypto.randomUUID(), name, collapsed: false }, rowKey))

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(menuOpen) => {
          if (!menuOpen && queued) runQueued()
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover/project:opacity-100 group-data-[menu-open=true]/project:opacity-100 focus:opacity-100"
              aria-label={m.sidebar_project_actions({ project: projects[0].name })}
            />
          }
        >
          <RiMoreFill aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <MoveToGroupSubmenu rowKey={rowKey} onNewGroup={() => setQueued({ action: "newGroup" })} />
          <DropdownMenuSeparator />
          {projects.length === 1 ? (
            <ProjectMenuItems project={projects[0]} onPick={setQueued} />
          ) : (
            projects.map((project, index) => (
              <Fragment key={project.id}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{environmentName(environmentOf(project), clouds)}</DropdownMenuLabel>
                  <ProjectMenuItems project={project} onPick={setQueued} />
                </DropdownMenuGroup>
              </Fragment>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {projects.map((project) => (
        <Fragment key={project.id}>
          <ProjectDialog project={project} open={isOpen("edit", project)} onOpenChange={closeDialog} />
          <DeleteProjectDialog
            project={project}
            open={isOpen("delete", project)}
            onOpenChange={closeDialog}
            focusAfterDelete={focusAfterDelete}
          />
        </Fragment>
      ))}
      <GroupNameDialog open={dialog?.action === "newGroup"} onOpenChange={closeDialog} onSubmit={newGroup} />
    </>
  )
}

function MoveToGroupSubmenu({ rowKey, onNewGroup }: { rowKey: string; onNewGroup: () => void }) {
  const [state, update] = useSidebarGroups()
  const current = state.groups.find((group) => group.id === state.groupOf[rowKey])
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <RiFolderSharedLine aria-hidden />
        {m.sidebar_project_move_to_group()}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48">
        {state.groups.map((group) => (
          <DropdownMenuCheckboxItem
            key={group.id}
            checked={group.id === current?.id}
            disabled={group.id === current?.id}
            closeOnClick
            onCheckedChange={() => void update((next) => assignGroup(next, rowKey, group.id))}
          >
            <span className="truncate">{group.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {state.groups.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onNewGroup}>
          <RiAddLine aria-hidden />
          {m.sidebar_project_new_group()}
        </DropdownMenuItem>
        {current && (
          <DropdownMenuItem onClick={() => void update((next) => assignGroup(next, rowKey, null))}>
            <RiCloseLine aria-hidden />
            {m.sidebar_project_remove_from_group()}
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function ProjectMenuItems({ project, onPick }: { project: Project; onPick: (picked: Picked) => void }) {
  const busy = useThreads((state) =>
    Object.values(state.byId).some(
      (thread) =>
        thread.projectId === project.id && (thread.status === "running" || thread.status === "awaiting_approval"),
    ),
  )
  return (
    <>
      <DropdownMenuItem onClick={() => onPick({ action: "edit", project })}>
        <RiPencilLine aria-hidden />
        {m.sidebar_project_edit()}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onPick({ action: "newThread", project })}>
        <RiAddLine aria-hidden />
        {m.sidebar_project_new_thread()}
      </DropdownMenuItem>
      {project.kind === "folder" && (
        <DropdownMenuItem onClick={() => onPick({ action: "importSession", project })}>
          <RiInboxArchiveLine aria-hidden />
          {m.sidebar_project_import_session()}
        </DropdownMenuItem>
      )}
      {environmentOf(project) === null && <OpenWithSubmenu path={project.rootPath} target="folder" />}
      <DropdownMenuItem variant="destructive" disabled={busy} onClick={() => onPick({ action: "delete", project })}>
        <RiDeleteBinLine aria-hidden />
        {m.sidebar_project_delete()}
      </DropdownMenuItem>
    </>
  )
}
