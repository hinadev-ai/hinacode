import type { Thread } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"

export type ThreadActionName = "pin" | "unpin" | "archive" | "unarchive"

export interface ThreadAction {
  readonly name: ThreadActionName
  readonly label: string
  readonly icon: IconName
}

/** What a thread offers on long press: an archived thread can only come back, an active one can be pinned. */
export function threadActions(thread: Thread): readonly ThreadAction[] {
  if (thread.status === "archived")
    return [{ name: "unarchive", label: copy("mobile_thread_actions_unarchive"), icon: "RiInboxUnarchiveLine" }]
  return [
    thread.pinnedAt === null
      ? { name: "pin", label: copy("mobile_thread_actions_pin"), icon: "RiPushpinLine" }
      : { name: "unpin", label: copy("mobile_thread_actions_unpin"), icon: "RiUnpinLine" },
    { name: "archive", label: copy("mobile_thread_actions_archive"), icon: "RiArchiveLine" },
  ]
}

export const requestThreadAction = (thread: Thread, name: ThreadActionName) => {
  if (name === "pin" || name === "unpin") return call("threads.update", { id: thread.id, pinned: name === "pin" })
  return call(name === "archive" ? "threads.archive" : "threads.unarchive", { threadId: thread.id })
}
