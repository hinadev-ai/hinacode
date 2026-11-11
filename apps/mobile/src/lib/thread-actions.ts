import type { ProviderId } from "@shared/agent.ts"
import { isThreadBusy, type Thread } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"

type ServerThreadActionName = "pin" | "unpin" | "settle" | "unsettle" | "archive" | "unarchive"
export type ThreadActionName = ServerThreadActionName | "copy-id" | "rename" | "fork" | "reveal" | "delete"

export interface ThreadAction {
  readonly name: ThreadActionName
  readonly label: string
  readonly icon: IconName
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

const forksSessions = { claude: true, codex: true, muse: false, opencode: false, magpie: true } satisfies Record<ProviderId, boolean>

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
    ...(forksSessions[thread.provider]
      ? [{ name: "fork", label: copy("mobile_thread_actions_fork"), icon: "Fork", group: 0 } as const]
      : []),
    copyId,
    { name: "reveal", label: copy("mobile_thread_actions_reveal"), icon: "Computer", group: 1 },
    ...(thread.settledAt !== null
      ? [{ name: "unsettle", label: copy("mobile_thread_actions_reopen"), icon: "Unarchive", group: 2 } as const]
      : isThreadBusy(thread.status)
        ? []
        : [{ name: "settle", label: copy("mobile_thread_actions_settle"), icon: "Check", group: 2 } as const]),
    { name: "archive", label: copy("mobile_thread_actions_archive"), icon: "Archive", group: 2 },
    ...(isThreadBusy(thread.status) ? [] : [remove]),
  ]
}

export const leavesThread = (name: ThreadActionName) => name === "archive" || name === "delete"

export const actionGroups = (actions: readonly ThreadAction[]) =>
  [0, 1, 2].map((group) => actions.filter((action) => action.group === group)).filter((group) => group.length > 0)

const serverActions: ReadonlySet<ThreadActionName> = new Set(["pin", "unpin", "settle", "unsettle", "archive", "unarchive"])

export const isServerAction = (name: ThreadActionName): name is ServerThreadActionName => serverActions.has(name)

export const requestThreadAction = (thread: Thread, name: ServerThreadActionName) => {
  if (name === "pin" || name === "unpin") return call("threads.update", { id: thread.id, pinned: name === "pin" })
  if (name === "settle" || name === "unsettle") return call(`threads.${name}`, { threadId: thread.id })
  return call(name === "archive" ? "threads.archive" : "threads.unarchive", { threadId: thread.id })
}

export const threadActionSymbols = {
  pin: "pin",
  unpin: "pin.slash",
  rename: "pencil",
  fork: "arrow.triangle.branch",
  "copy-id": "doc.on.doc",
  reveal: "desktopcomputer",
  settle: "checkmark.circle",
  unsettle: "arrow.uturn.backward.circle",
  archive: "archivebox",
  unarchive: "tray.and.arrow.up",
  delete: "trash",
} as const satisfies Record<ThreadActionName, string>
