import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { toast } from "sonner"
import { type Changes, isThreadBusy } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { lineCounts } from "../lib/patch.ts"
import { callPromise, threadChangesAtom, turnChangesAtom, turnChangesKey } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { FileDiffIcon, UndoIcon } from "@hinacode/icons"
import { Button } from "./ui/button.tsx"
import { LineCounts } from "./LineCounts.tsx"

export function TurnChanges({ threadId, messageId }: { threadId: string; messageId: string }) {
  const atom = turnChangesAtom(turnChangesKey(threadId, messageId))
  const changes = AsyncResult.getOrElse(useAtomValue(atom), (): Changes | null => null)
  const refresh = useAtomRefresh(atom)
  const refreshPanel = useAtomRefresh(threadChangesAtom(`${threadId}\nturn`))
  const busy = useThreads((state) => isThreadBusy(state.byId[threadId]?.status ?? "idle"))
  const [undoneCount, setUndoneCount] = useState<number | null>(null)

  if (undoneCount !== null) {
    return <p className="my-3 text-sm text-muted-foreground">{m.turn_changes_undone({ count: undoneCount })}</p>
  }
  if (changes === null || changes.files.length === 0) return null

  const { added, removed } = lineCounts(changes.patch)
  const undo = async () => {
    try {
      await callPromise("threads.undoTurn", { threadId })
      setUndoneCount(changes.files.length)
      refresh()
      refreshPanel()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
  const viewChanges = () => {
    const ui = useUi.getState()
    ui.setChangesScope(threadId, "turn")
    ui.showView(threadId, "changes")
  }

  return (
    <section className="my-3 flex items-center gap-3 rounded-2xl border border-border p-2.5 pr-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
        <FileDiffIcon aria-hidden className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="truncate text-sm font-medium">{summarize(changes)}</h3>
        <p className="text-xs">
          <LineCounts added={added} removed={removed} />
        </p>
      </div>
      <Button variant="ghost" size="sm" disabled={busy} action={undo}>
        {m.turn_changes_undo()}
        <UndoIcon aria-hidden data-icon="inline-end" />
      </Button>
      <Button variant="outline" size="sm" action={viewChanges}>
        {m.turn_changes_view()}
      </Button>
    </section>
  )
}

function summarize({ files }: Changes): string {
  const [only] = files
  if (files.length !== 1 || only === undefined) return m.turn_changes_files({ count: files.length })
  const file = only.path.slice(only.path.lastIndexOf("/") + 1)
  if (only.status === "added" || only.status === "untracked") return m.turn_changes_created({ file })
  if (only.status === "deleted") return m.turn_changes_deleted({ file })
  return m.turn_changes_edited({ file })
}
