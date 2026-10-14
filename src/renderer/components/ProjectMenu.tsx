import { type RefObject, useState } from "react"
import { RiAddLine, RiDeleteBinLine, RiFolderOpenLine, RiMoreFill, RiPencilLine } from "react-icons/ri"
import type { Project } from "../../shared/domain.ts"
import { callPromise } from "../lib/rpc.ts"
import { useMenuAction } from "../lib/useMenuAction.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { DeleteProjectDialog } from "./DeleteProjectDialog.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { Button } from "./ui/button.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx"

interface ProjectMenuProps {
  readonly project: Project
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onNewThread: () => void
  /** Takes focus after the project is deleted. */
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

/** The "…" menu on a project header, with the dialogs its items open. */
export function ProjectMenu({ project, open, onOpenChange, onNewThread, focusAfterDelete }: ProjectMenuProps) {
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null)
  const menuAction = useMenuAction((action: "edit" | "newThread" | "delete") => {
    if (action === "newThread") onNewThread()
    else setDialog(action)
  })
  const busy = useThreads((state) =>
    Object.values(state.byId).some(
      (thread) =>
        thread.projectId === project.id && (thread.status === "running" || thread.status === "awaiting_approval"),
    ),
  )

  const closeDialog = (dialogOpen: boolean) => {
    if (!dialogOpen) setDialog(null)
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange} onOpenChangeComplete={menuAction.onOpenChangeComplete}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover/project:opacity-100 group-data-[menu-open=true]/project:opacity-100 focus:opacity-100"
              aria-label={m.sidebar_project_actions({ project: project.name })}
            />
          }
        >
          <RiMoreFill aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => menuAction.queue("edit")}>
            <RiPencilLine aria-hidden />
            {m.sidebar_project_edit()}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => menuAction.queue("newThread")}>
            <RiAddLine aria-hidden />
            {m.sidebar_project_new_thread()}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void callPromise("shell.reveal", { path: project.rootPath })}>
            <RiFolderOpenLine aria-hidden />
            {m.sidebar_project_reveal()}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={busy} onClick={() => menuAction.queue("delete")}>
            <RiDeleteBinLine aria-hidden />
            {m.sidebar_project_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProjectDialog project={project} open={dialog === "edit"} onOpenChange={closeDialog} />
      <DeleteProjectDialog
        project={project}
        open={dialog === "delete"}
        onOpenChange={closeDialog}
        focusAfterDelete={focusAfterDelete}
      />
    </>
  )
}
