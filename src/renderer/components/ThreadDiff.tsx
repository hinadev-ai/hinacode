import { useAtomRefresh, useAtomSuspense, useAtomValue } from "@effect/atom-react"
import { PatchDiff } from "@pierre/diffs/react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Suspense, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react"
import { RiRefreshLine } from "react-icons/ri"
import type { ChangedFileStatus, ChangesScope, Thread } from "../../shared/domain.ts"
import { useTheme } from "../lib/appearance.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { threadChangesAtom } from "../lib/rpc.ts"
import { useClientSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { useWorktrees } from "../stores/worktrees.ts"
import { fileStatusLabel, fileStatusMark } from "./FilePatch.tsx"
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

// PatchDiff renders a whole file in one frame, about 0.07 ms per line: a 12k-line lockfile blocked for 860 ms.
// Past this many changed lines the file is almost always generated, so it waits until the user asks for it.
const LARGE_DIFF_LINES = 1000

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
  const diffs = useMemo(() => splitPatch(loaded?.patch ?? "", loaded?.files.map((file) => file.path) ?? []), [loaded])

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
        <ChangedFileRow
          key={file.path}
          path={file.path}
          status={file.status}
          diff={diffs.get(file.path)}
          open={openPath === file.path}
          setOpenPath={setOpenPath}
        />
      ))}
    </ul>
  )
}

interface ChangedFileRowProps {
  readonly path: string
  readonly status: ChangedFileStatus
  readonly diff: FileDiff | undefined
  readonly open: boolean
  readonly setOpenPath: (path: string | null) => void
}

function ChangedFileRow({ path, status, diff, open, setOpenPath }: ChangedFileRowProps) {
  const diffId = useId()
  const mark = fileStatusMark[status]
  const added = diff?.added ?? 0
  const removed = diff?.removed ?? 0
  const [showLarge, setShowLarge] = useState(false)
  const theme = useTheme(useClientSettings().appearance.theme)

  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={diffId}
        onClick={() => setOpenPath(open ? null : path)}
        className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
      >
        <abbr title={fileStatusLabel[status]()} className={`w-3 shrink-0 font-mono no-underline ${mark.className}`}>
          {mark.letter}
        </abbr>
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {path}
        </span>
        <span className="shrink-0 font-mono tabular-nums" aria-label={m.diff_line_counts({ added, removed })}>
          <span aria-hidden className="text-vcs-added">
            +{added}
          </span>{" "}
          <span aria-hidden className="text-destructive">
            −{removed}
          </span>
        </span>
      </button>
      {open && (
        <div id={diffId} className="overflow-hidden rounded-md border border-border text-xs">
          {!diff ? (
            <p className="p-2 text-muted-foreground">{m.diff_file_missing()}</p>
          ) : added + removed > LARGE_DIFF_LINES && !showLarge ? (
            <div className="flex items-center justify-between gap-2 p-2">
              <p className="text-muted-foreground">{m.diff_large({ lines: added + removed })}</p>
              <Button variant="outline" size="xs" onClick={() => setShowLarge(true)}>
                {m.diff_large_show()}
              </Button>
            </div>
          ) : (
            <PatchDiff
              patch={diff.patch}
              options={{
                diffStyle: "unified",
                theme: theme.codeTheme,
                themeType: theme.scheme,
                overflow: "wrap",
                disableFileHeader: true,
              }}
            />
          )}
        </div>
      )}
    </li>
  )
}
