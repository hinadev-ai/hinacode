import { useAtomRefresh } from "@effect/atom-react"
import { useNavigate, useParams } from "@tanstack/react-router"
import type { RefObject } from "react"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"
import type { SidebarGroup } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, projectsAtom } from "../lib/rpc.ts"
import { deleteGroup } from "../lib/sidebarGroups.ts"
import { useSidebarGroups } from "../lib/useSidebarGroups.ts"
import { m } from "../paraglide/messages.js"
import { hasContent, useDrafts } from "../stores/drafts.ts"
import { selectOpenableThread, useThreads } from "../stores/threads.ts"
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

export function useConductorThreadCount(groupId: string) {
  const started = useThreads(
    (state) => Object.values(state.byId).filter((thread) => thread.projectId === groupId).length,
  )
  const draftIds = useThreads(
    useShallow((state) =>
      Object.values(state.drafts)
        .filter((thread) => thread.projectId === groupId)
        .map((thread) => thread.id),
    ),
  )
  const written = useDrafts(
    (state) =>
      draftIds.filter((id) => {
        const draft = state.byThreadId[id]
        return draft !== undefined && hasContent(draft)
      }).length,
  )
  return started + written
}

export function useDeleteGroup(group: SidebarGroup, focusAfterDelete: RefObject<HTMLElement | null>) {
  const [, update] = useSidebarGroups()
  const refreshProjects = useAtomRefresh(projectsAtom)
  const navigate = useNavigate()
  const { threadId: openThreadId } = useParams({ strict: false })
  return async () => {
    if (!(await update((state) => deleteGroup(state, group.id)))) return
    const open = openThreadId === undefined ? undefined : selectOpenableThread(openThreadId)(useThreads.getState())
    try {
      await callPromise("projects.delete", { id: group.id })
    } catch (cause) {
      toast.error(m.sidebar_group_delete_failed({ group: group.name, message: errorMessage(cause) }))
      return
    }
    if (open?.projectId === group.id) void navigate({ to: "/" })
    refreshProjects()
    focusAfterDelete.current?.focus()
  }
}

interface DeleteGroupDialogProps {
  readonly name: string
  readonly threadCount: number
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: () => Promise<void>
}

export function DeleteGroupDialog({ name, threadCount, open, onOpenChange, onConfirm }: DeleteGroupDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.project_delete_title({ project: name })}</AlertDialogTitle>
          <AlertDialogDescription>{m.project_delete_body({ count: threadCount })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" action={onConfirm}>
            {m.sidebar_group_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
