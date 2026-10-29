import { useActionState } from "react"
import { isThreadBusy, type Thread, type Worktree } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
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

export const useActiveWorktree = (thread: Thread) =>
  useWorktrees((state) => {
    const worktree = thread.worktreeId ? state.byId[thread.worktreeId] : undefined
    return worktree && worktree.status !== "removed" ? worktree : undefined
  })

interface ArchiveDialogProps {
  readonly thread: Thread
  readonly worktree: Worktree
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onArchived: (thread: Thread) => void
}

export function ArchiveDialog({ thread, worktree, open, onOpenChange, onArchived }: ArchiveDialogProps) {
  const [error, archive, isPending] = useActionState(async () => {
    try {
      onArchived(await callPromise("threads.archive", { threadId: thread.id }))
    } catch (cause) {
      return errorMessage(cause)
    }
    onOpenChange(false)
    return null
  }, null)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.archive_dialog_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.archive_dialog_worktree({ path: worktree.path })}</AlertDialogDescription>
          <AlertDialogDescription>
            {m.archive_dialog_branch({ branch: worktree.branch, baseRef: worktree.baseRef })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending || isThreadBusy(thread.status)} action={archive}>
            {m.archive_dialog_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
