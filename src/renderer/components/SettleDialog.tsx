import { startTransition, useActionState } from "react"
import { isThreadBusy, type Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
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

/** The thread's worktree while it still exists on disk. */
export const useActiveWorktree = (thread: Thread) =>
  useWorktrees((state) => {
    const worktree = thread.worktreeId ? state.byId[thread.worktreeId] : undefined
    return worktree && worktree.status !== "removed" ? worktree : undefined
  })

interface SettleDialogProps {
  readonly thread: Thread
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

/** Confirms settling a thread, which also deletes its worktree folder when it has one. */
export function SettleDialog({ thread, open, onOpenChange }: SettleDialogProps) {
  const worktree = useActiveWorktree(thread)

  const [error, settle, isPending] = useActionState(async () => {
    try {
      useThreads.getState().upsert(await callPromise("threads.settle", { threadId: thread.id }))
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
          <AlertDialogTitle>{m.settle_dialog_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {worktree ? m.settle_dialog_worktree({ path: worktree.path }) : m.settle_dialog_root()}
          </AlertDialogDescription>
          {worktree && (
            <AlertDialogDescription>
              {m.settle_dialog_branch({ branch: worktree.branch, baseRef: worktree.baseRef })}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant={worktree ? "destructive" : "default"}
            disabled={isPending || isThreadBusy(thread.status)}
            onClick={() => startTransition(settle)}
          >
            {worktree ? m.settle_dialog_confirm_worktree() : m.settle_dialog_confirm_root()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
