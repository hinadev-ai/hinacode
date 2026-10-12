import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { PatchDiff } from "@pierre/diffs/react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useId, useRef, useState } from "react"
import { RiRefreshLine } from "react-icons/ri"
import type { ChangedFileStatus, ChangesScope, Thread } from "../../shared/domain.ts"
import { useTheme } from "../lib/appearance.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { threadChangesAtom } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { useWorktrees } from "../stores/worktrees.ts"
import { fileStatusLabel, fileStatusMark } from "./FilePatch.tsx"
import { useUi } from "../stores/ui.ts"
import { Button } from "./ui/button.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"

/** The single-file section of a combined `git diff`, found by its `diff --git a/… b/<path>` header. */
const patchForFile = (patch: string, path: string) =>
  patch.split(/^(?=diff --git )/m).find((chunk) => chunk.slice(0, chunk.indexOf("\n")).endsWith(` b/${path}`))

const lineCounts = (filePatch: string | undefined) => {
  let added = 0
  let removed = 0
  for (const line of filePatch?.split("\n") ?? []) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

/** The Diff tab: what the thread changed in its worktree, or in its latest turn. */
export function ThreadDiff({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const hasWorktree = worktree !== undefined && worktree.status !== "removed"
  const [scope, setScope] = useState<ChangesScope>(hasWorktree ? "worktree" : "turn")

  return (
    <div className="flex flex-col gap-3 p-4">
      <Tabs value={scope} onValueChange={(value: ChangesScope) => setScope(value)}>
        <TabsList aria-label={m.diff_scope_label()} className="w-full">
          <TabsTrigger value="worktree">{m.diff_scope_worktree()}</TabsTrigger>
          <TabsTrigger value="turn">{m.diff_scope_turn()}</TabsTrigger>
        </TabsList>
      </Tabs>
      <ChangesList
        key={scope}
        thread={thread}
        scope={scope}
        baseLabel={
          scope === "worktree" && worktree ? m.diff_base_worktree({ baseRef: worktree.baseRef }) : m.diff_base_turn()
        }
      />
    </div>
  )
}

function ChangesList({ thread, scope, baseLabel }: { thread: Thread; scope: ChangesScope; baseLabel: string }) {
  const changesAtom = threadChangesAtom(`${thread.id}\n${scope}`)
  const changes = useAtomValue(changesAtom)
  const refresh = useAtomRefresh(changesAtom)
  const openPath = useUi((state) => state.changesPath)
  const setOpenPath = useUi((state) => state.setChangesPath)

  useEffect(() => {
    useUi.getState().setSidePanelWide(openPath !== null)
    return () => useUi.getState().setSidePanelWide(false)
  }, [openPath])

  // A turn starting or ending is when the diff moves; ask again then instead of polling.
  const lastStatus = useRef(thread.status)
  useEffect(() => {
    if (lastStatus.current === thread.status) return
    lastStatus.current = thread.status
    refresh()
  }, [thread.status, refresh])

  return (
    <section aria-label={baseLabel} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{baseLabel}</p>
        <Button variant="ghost" size="icon-xs" aria-label={m.diff_refresh()} title={m.diff_refresh()} onClick={refresh}>
          <RiRefreshLine
            aria-hidden
            className={changes.waiting ? "animate-spin motion-reduce:animate-none" : undefined}
          />
        </Button>
      </div>
      {AsyncResult.builder(changes)
        .onInitial(() => <p className="text-xs text-muted-foreground">{m.diff_loading()}</p>)
        .onSuccess((result) => {
          if (result === null) {
            return (
              <p className="text-xs text-muted-foreground">
                {scope === "worktree" ? m.diff_no_worktree() : m.diff_no_turn()}
              </p>
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
                  filePatch={patchForFile(result.patch, file.path)}
                  open={openPath === file.path}
                  onToggle={() => setOpenPath(openPath === file.path ? null : file.path)}
                />
              ))}
            </ul>
          )
        })
        .onError((error) => (
          <p role="alert" className="text-xs text-destructive">
            {m.diff_failed({ message: errorMessage(error) })}
          </p>
        ))
        .orElse(() => null)}
    </section>
  )
}

interface ChangedFileRowProps {
  readonly path: string
  readonly status: ChangedFileStatus
  readonly filePatch: string | undefined
  readonly open: boolean
  readonly onToggle: () => void
}

function ChangedFileRow({ path, status, filePatch, open, onToggle }: ChangedFileRowProps) {
  const diffId = useId()
  const mark = fileStatusMark[status]
  const { added, removed } = lineCounts(filePatch)
  const theme = useTheme(useSettings().appearance.theme)

  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={diffId}
        onClick={onToggle}
        className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
      >
        <abbr title={fileStatusLabel[status]()} className={`w-3 shrink-0 font-mono no-underline ${mark.className}`}>
          {mark.letter}
        </abbr>
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {path}
        </span>
        <span className="shrink-0 font-mono tabular-nums" aria-label={m.diff_line_counts({ added, removed })}>
          <span aria-hidden className="text-emerald-500">
            +{added}
          </span>{" "}
          <span aria-hidden className="text-destructive">
            −{removed}
          </span>
        </span>
      </button>
      {open && (
        <div id={diffId} className="overflow-hidden rounded-md border border-border text-xs">
          {filePatch ? (
            <PatchDiff
              patch={filePatch}
              options={{
                diffStyle: "unified",
                theme: theme.codeTheme,
                themeType: theme.scheme,
                overflow: "wrap",
                disableFileHeader: true,
              }}
            />
          ) : (
            <p className="p-2 text-muted-foreground">{m.diff_file_missing()}</p>
          )}
        </div>
      )}
    </li>
  )
}
