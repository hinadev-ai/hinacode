import { useAtomRefresh, useAtomSuspense, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Suspense, useDeferredValue, useEffect, useRef, useState } from "react"
import { RiRefreshLine } from "react-icons/ri"
import type { ChangesScope, Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { threadChangesAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useWorktrees } from "../stores/worktrees.ts"
import { FileDiffRow, fileStatusMark } from "./FilePatch.tsx"
import { useUi } from "../stores/ui.ts"
import { Button } from "./ui/button.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"

interface FileDiff {
  readonly patch: string
  readonly added: number
  readonly removed: number
}

const lineCounts = (filePatch: string) => {
  let added = 0
  let removed = 0
  for (const line of filePatch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

/** Each file's section of a combined `git diff`, found by its `diff --git a/… b/<path>` header, with its line counts. */
const splitPatch = (patch: string, paths: ReadonlyArray<string>) => {
  const chunks = patch.split(/^(?=diff --git )/m)
  const byPath = new Map<string, FileDiff>()
  for (const path of paths) {
    const chunk = chunks.find((candidate) => candidate.slice(0, candidate.indexOf("\n")).endsWith(` b/${path}`))
    if (chunk !== undefined) byPath.set(path, { patch: chunk, ...lineCounts(chunk) })
  }
  return byPath
}

/** The Diff tab: what the thread changed in its worktree, or in its latest turn. */
export function ThreadDiff({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const hasWorktree = worktree !== undefined && worktree.status !== "removed"
  const [scope, setScope] = useState<ChangesScope>(hasWorktree ? "worktree" : "turn")
  // Switching scope keeps the last list on screen until the other one loads.
  const shownScope = useDeferredValue(scope)

  return (
    <div className="flex flex-col gap-3 p-4">
      <Tabs value={scope} onValueChange={(value: ChangesScope) => setScope(value)}>
        <TabsList aria-label={m.diff_scope_label()} className="w-full">
          <TabsTrigger value="worktree">{m.diff_scope_worktree()}</TabsTrigger>
          <TabsTrigger value="turn">{m.diff_scope_turn()}</TabsTrigger>
        </TabsList>
      </Tabs>
      <ChangesList
        thread={thread}
        scope={shownScope}
        stale={shownScope !== scope}
        baseLabel={
          shownScope === "worktree" && worktree
            ? m.diff_base_worktree({ baseRef: worktree.baseRef })
            : m.diff_base_turn()
        }
      />
    </div>
  )
}

interface ChangesListProps {
  readonly thread: Thread
  readonly scope: ChangesScope
  /** The other scope is still loading behind this one. */
  readonly stale: boolean
  readonly baseLabel: string
}

function ChangesList({ thread, scope, stale, baseLabel }: ChangesListProps) {
  const changesAtom = threadChangesAtom(`${thread.id}\n${scope}`)
  const changes = useAtomValue(changesAtom)
  const refresh = useAtomRefresh(changesAtom)

  // A turn starting or ending is when the diff moves; ask again then instead of polling.
  const lastStatus = useRef(thread.status)
  useEffect(() => {
    if (lastStatus.current === thread.status) return
    lastStatus.current = thread.status
    refresh()
  }, [thread.status, refresh])

  return (
    <section
      aria-label={baseLabel}
      className={cn("flex flex-col gap-2 transition-opacity", stale && "opacity-60 delay-150")}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{baseLabel}</p>
        <Button variant="ghost" size="icon-xs" aria-label={m.diff_refresh()} title={m.diff_refresh()} onClick={refresh}>
          <RiRefreshLine
            aria-hidden
            className={changes.waiting ? "animate-spin-late motion-reduce:animate-none" : undefined}
          />
        </Button>
      </div>
      <Suspense fallback={<p className="animate-reveal text-xs text-muted-foreground">{m.diff_loading()}</p>}>
        <ChangedFiles key={scope} threadId={thread.id} scope={scope} />
      </Suspense>
    </section>
  )
}

function ChangedFiles({ threadId, scope }: { threadId: string; scope: ChangesScope }) {
  const changes = useAtomSuspense(threadChangesAtom(`${threadId}\n${scope}`), { includeFailure: true })
  const openPath = useUi((state) => state.changesPath)
  const setOpenPath = useUi((state) => state.setChangesPath)

  useEffect(() => {
    useUi.getState().setSidePanelWide(openPath !== null)
    return () => useUi.getState().setSidePanelWide(false)
  }, [openPath])

  const loaded = AsyncResult.isSuccess(changes) ? changes.value : null
  const diffs = splitPatch(loaded?.patch ?? "", loaded?.files.map((file) => file.path) ?? [])

  if (AsyncResult.isFailure(changes)) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {m.diff_failed({ message: errorMessage(Cause.squash(changes.cause)) })}
      </p>
    )
  }
  const result = changes.value
  if (result === null) {
    return (
      <p className="text-xs text-muted-foreground">{scope === "worktree" ? m.diff_no_worktree() : m.diff_no_turn()}</p>
    )
  }
  if (result.files.length === 0) return <p className="text-xs text-muted-foreground">{m.diff_empty()}</p>
  return (
    <ul className="flex flex-col gap-0.5">
      {result.files.map((file) => (
        <FileDiffRow
          key={file.path}
          path={file.path}
          mark={fileStatusMark[file.status]}
          added={diffs.get(file.path)?.added ?? 0}
          removed={diffs.get(file.path)?.removed ?? 0}
          patch={diffs.get(file.path)?.patch}
          open={openPath === file.path}
          onToggle={() => setOpenPath(openPath === file.path ? null : file.path)}
        />
      ))}
    </ul>
  )
}
