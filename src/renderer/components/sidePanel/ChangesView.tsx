import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useId } from "react"
import { RiRefreshLine } from "react-icons/ri"
import type { ChangedFileStatus, Thread } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { worktreeChangesAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useUi } from "../../stores/ui.ts"
import { useWorktrees } from "../../stores/worktrees.ts"
import { FilePatch, fileStatusLabel, fileStatusMark } from "../FilePatch.tsx"
import { Button } from "../ui/button.tsx"
import { ViewBody } from "./Section.tsx"

/** What the worktree changed since it forked, one row per file, each opening its diff. */
export function ChangesView({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  if (!worktree) return <Note text={m.panel_changes_root()} />
  if (worktree.status === "removed") return <Note text={m.panel_changes_removed()} />
  return <WorktreeChanges worktreeId={worktree.id} />
}

function Note({ text }: { text: string }) {
  return (
    <ViewBody>
      <p className="text-xs text-muted-foreground">{text}</p>
    </ViewBody>
  )
}

function WorktreeChanges({ worktreeId }: { worktreeId: string }) {
  const changesAtom = worktreeChangesAtom(worktreeId)
  const changes = useAtomValue(changesAtom)
  const refresh = useAtomRefresh(changesAtom)
  const openPath = useUi((state) => state.changesPath)
  const setOpenPath = useUi((state) => state.setChangesPath)

  // A diff needs the room a file viewer gets.
  useEffect(() => {
    useUi.getState().setSidePanelWide(openPath !== null)
    return () => useUi.getState().setSidePanelWide(false)
  }, [openPath])

  return (
    <ViewBody>
      {AsyncResult.builder(changes)
        .onInitial(() => <p className="text-xs text-muted-foreground">{m.panel_changes_loading()}</p>)
        .onSuccess(({ baseRef, files, patch }) => (
          <div className="flex flex-col gap-2">
            <div className="flex min-h-6 items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{m.panel_changes_base({ baseRef })}</p>
              <RefreshButton waiting={changes.waiting} onClick={refresh} />
            </div>
            {files.length === 0 ? (
              <p className="text-xs text-muted-foreground">{m.panel_changes_empty()}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {files.map((file) => (
                  <ChangedFileRow
                    key={file.path}
                    path={file.path}
                    status={file.status}
                    patch={patch}
                    open={openPath === file.path}
                    onToggle={() => setOpenPath(openPath === file.path ? null : file.path)}
                  />
                ))}
              </ul>
            )}
          </div>
        ))
        .onError((error) => (
          <div className="flex items-start justify-between gap-2">
            <p role="alert" className="text-xs text-destructive">
              {m.panel_changes_failed({ message: errorMessage(error) })}
            </p>
            <RefreshButton waiting={changes.waiting} onClick={refresh} />
          </div>
        ))
        .orElse(() => null)}
    </ViewBody>
  )
}

function RefreshButton({ waiting, onClick }: { waiting: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={m.panel_changes_refresh()}
      title={m.panel_changes_refresh()}
      onClick={onClick}
    >
      <RiRefreshLine aria-hidden className={waiting ? "animate-spin motion-reduce:animate-none" : undefined} />
    </Button>
  )
}

interface ChangedFileRowProps {
  readonly path: string
  readonly status: ChangedFileStatus
  readonly patch: string
  readonly open: boolean
  readonly onToggle: () => void
}

function ChangedFileRow({ path, status, patch, open, onToggle }: ChangedFileRowProps) {
  const diffId = useId()
  const mark = fileStatusMark[status]

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
        <span className="truncate font-mono" title={path}>
          {path}
        </span>
      </button>
      {open && (
        <div id={diffId} className="overflow-hidden rounded-md border border-border text-xs">
          <FilePatch patch={patch} path={path} />
        </div>
      )}
    </li>
  )
}
