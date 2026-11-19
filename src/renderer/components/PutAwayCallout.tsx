// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live region groups the explanation and its action.
import { toast } from "sonner"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { Button } from "./ui/button.tsx"
import { ArchiveIcon, CheckIcon, UnarchiveIcon } from "@hinacode/icons"

export type PutAway = "archived" | "settled"

export const putAwayOf = (thread: Pick<Thread, "status" | "settledAt">): PutAway | null => {
  if (thread.status === "archived") return "archived"
  return thread.settledAt === null ? null : "settled"
}

export const putAwayStates = {
  archived: { label: m.thread_status_archived, Icon: ArchiveIcon, reopen: "threads.unarchive" },
  settled: { label: m.thread_status_settled, Icon: CheckIcon, reopen: "threads.unsettle" },
} as const satisfies Record<PutAway, { label: () => string; Icon: unknown; reopen: string }>

export function PutAwayCallout({ threadId, putAway }: { threadId: string; putAway: PutAway }) {
  const { Icon, reopen: method } = putAwayStates[putAway]
  const reopen = async () => {
    try {
      useThreads.getState().upsert(await callPromise(method, { threadId }))
      useUi.getState().requestComposerFocus()
    } catch (cause) {
      toast.error(m.sidebar_unarchive_failed({ message: errorMessage(cause) }))
    }
  }
  return (
    <section
      role="status"
      className="mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/50 py-2 ps-3 pe-2"
    >
      <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
        <Icon aria-hidden className="size-4 shrink-0" />
        {m.thread_send_reopens()}
      </p>
      <Button type="button" variant="outline" size="sm" action={reopen}>
        <UnarchiveIcon aria-hidden />
        {m.sidebar_thread_unarchive()}
      </Button>
    </section>
  )
}
