import type { Thread } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"

type ServerThreadActionName = "pin" | "unpin" | "archive" | "unarchive"
export type ThreadActionName = ServerThreadActionName | "copy-id" | "rename" | "fork" | "reveal" | "delete"

export interface ThreadAction {
  readonly name: ThreadActionName
  readonly label: string
  readonly icon: IconName
  /** Menus split actions into groups: change the thread, reach it elsewhere, put it away. */
  readonly group: 0 | 1 | 2
  readonly destructive?: boolean
}

const copyId: ThreadAction = { name: "copy-id", label: copy("mobile_thread_actions_copy_id"), icon: "Copy", group: 1 }
const remove: ThreadAction = {
  name: "delete",
  label: copy("mobile_thread_actions_delete"),
  icon: "Trash",
  group: 2,
  destructive: true,
}

/** What a thread offers on long press: an archived thread can only come back or go, an active one can change. */
export function threadActions(thread: Thread): readonly ThreadAction[] {
  if (thread.status === "archived")
    return [
      copyId,
      { name: "unarchive", label: copy("mobile_thread_actions_unarchive"), icon: "Unarchive", group: 2 },
      remove,
    ]
  return [
    thread.pinnedAt === null
      ? { name: "pin", label: copy("mobile_thread_actions_pin"), icon: "Pin", group: 0 }
      : { name: "unpin", label: copy("mobile_thread_actions_unpin"), icon: "Unpin", group: 0 },
    { name: "rename", label: copy("mobile_thread_actions_rename"), icon: "Pencil", group: 0 },
    { name: "fork", label: copy("mobile_thread_actions_fork"), icon: "Fork", group: 0 },
    copyId,
    { name: "reveal", label: copy("mobile_thread_actions_reveal"), icon: "Computer", group: 1 },
    { name: "archive", label: copy("mobile_thread_actions_archive"), icon: "Archive", group: 2 },
    remove,
  ]
}

/** `actions` in their menu groups, in order. */
export const actionGroups = (actions: readonly ThreadAction[]) =>
  [0, 1, 2].map((group) => actions.filter((action) => action.group === group)).filter((group) => group.length > 0)

export const isServerAction = (name: ThreadActionName): name is ServerThreadActionName =>
  name === "pin" || name === "unpin" || name === "archive" || name === "unarchive"

export const requestThreadAction = (thread: Thread, name: ServerThreadActionName) => {
  if (name === "pin" || name === "unpin") return call("threads.update", { id: thread.id, pinned: name === "pin" })
  return call(name === "archive" ? "threads.archive" : "threads.unarchive", { threadId: thread.id })
}
