import { useAtomRefresh } from "@effect/atom-react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { type RefObject, startTransition, useActionState, useId, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import type { Project } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, projectsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { selectProjectThreads, useThreads } from "../stores/threads.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
import { Field, FieldLabel } from "./ui/field.tsx"

interface DeleteProjectDialogProps {
  readonly project: Project
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Takes focus once the project is gone, since the header that opened the dialog is gone too. */
  readonly focusAfterDelete: RefObject<HTMLElement | null>
}

interface DeleteState {
  readonly error: string | null
  readonly deleted: boolean
}

export function DeleteProjectDialog({ project, open, onOpenChange, focusAfterDelete }: DeleteProjectDialogProps) {
  const threads = useThreads(useShallow(selectProjectThreads(project.id)))
  const worktrees = useWorktrees(
    useShallow((state) =>
      Object.values(state.byId).filter(
        (worktree) => worktree.projectId === project.id && worktree.status !== "removed",
      ),
    ),
  )
  const refreshProjects = useAtomRefresh(projectsAtom)
  const navigate = useNavigate()
  const { threadId: openThreadId } = useParams({ strict: false })
  const [removeWorktrees, setRemoveWorktrees] = useState(true)
  const removeWorktreesId = useId()

  const [state, remove, isPending] = useActionState<DeleteState>(
    async () => {
      try {
        if (removeWorktrees) {
          for (const worktree of worktrees) {
            useWorktrees
              .getState()
              .upsert(await callPromise("worktrees.remove", { id: worktree.id, deleteBranch: "ifMerged" }))
          }
        }
        await callPromise("projects.delete", { id: project.id })
      } catch (cause) {
        return { error: errorMessage(cause), deleted: false }
      }
      onOpenChange(false)
      return { error: null, deleted: true }
    },
    { error: null, deleted: false },
  )

  // Runs once the dialog has closed and moved focus, since dropping the project unmounts the dialog.
  const dropProject = async () => {
    if (threads.some((thread) => thread.id === openThreadId)) await navigate({ to: "/" })
    const { remove: removeThread } = useThreads.getState()
    threads.forEach((thread) => removeThread(thread.id))
    refreshProjects()
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(dialogOpen) => {
        if (!dialogOpen && state.deleted) void dropProject()
      }}
    >
      <AlertDialogContent finalFocus={() => (state.deleted ? focusAfterDelete.current : true)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.project_delete_title({ project: project.name })}</AlertDialogTitle>
          <AlertDialogDescription>{m.project_delete_body({ count: threads.length })}</AlertDialogDescription>
          {worktrees.length > 0 && (
            <AlertDialogDescription>{m.project_delete_worktrees({ count: worktrees.length })}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {worktrees.length > 0 && (
          <Field orientation="horizontal">
            <Checkbox id={removeWorktreesId} checked={removeWorktrees} onCheckedChange={setRemoveWorktrees} />
            <FieldLabel htmlFor={removeWorktreesId}>{m.project_delete_remove_worktrees()}</FieldLabel>
          </Field>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={() => startTransition(remove)}>
            {m.project_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
