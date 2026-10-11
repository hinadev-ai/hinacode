import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { PatchDiff } from "@pierre/diffs/react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, startTransition, useActionState, useId, useState } from "react"
import { RiExternalLinkLine, RiFolderOpenLine, RiGitBranchLine, RiRefreshLine, RiSideBarFill } from "react-icons/ri"
import type { ChangedFileStatus, PullRequestState, Thread, Worktree, WorktreeStatus } from "../../shared/domain.ts"
import { callPromise, projectsAtom, pullRequestAtom, worktreeChangesAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { WorktreeSetupLog } from "./WorktreeSetupLog.tsx"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog.tsx"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

interface ThreadSidePanelProps {
  readonly thread: Thread
  readonly onHide: () => void
}

/** Right-hand panel of the thread route: where the thread runs, its setup log, its changes, and settling. */
export function ThreadSidePanel({ thread, onHide }: ThreadSidePanelProps) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))

  return (
    <aside aria-label={m.panel_label()} className="flex w-96 shrink-0 flex-col border-l border-border">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-sm font-semibold">{m.panel_label()}</h2>
        <PanelToggle expanded onToggle={onHide} />
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 p-4">
          <Section title={m.panel_workspace()}>
            {worktree ? <WorktreeWorkspace worktree={worktree} /> : <RootWorkspace projectId={thread.projectId} />}
          </Section>
          {worktree && (
            <Section title={m.panel_setup_log()}>
              <WorktreeSetupLog worktree={worktree} />
            </Section>
          )}
          <ChangesSection worktree={worktree} />
        </div>
      </ScrollArea>
      <footer className="shrink-0 border-t border-border p-3">
        <SettleControl thread={thread} worktree={worktree} />
      </footer>
    </aside>
  )
}

export function PanelToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const label = expanded ? m.panel_hide() : m.panel_show()
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} aria-expanded={expanded} onClick={onToggle}>
      <RiSideBarFill aria-hidden className="-scale-x-100" />
    </Button>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function RevealButton({ path, disabled }: { path: string; disabled?: boolean }) {
  return (
    <Button
      variant="outline"
      size="xs"
      className="self-start"
      disabled={disabled}
      onClick={() => void callPromise("shell.reveal", { path })}
    >
      <RiFolderOpenLine aria-hidden />
      {m.panel_reveal()}
    </Button>
  )
}

function RootWorkspace({ projectId }: { projectId: string }) {
  const projects = useAtomValue(projectsAtom)
  const project = AsyncResult.getOrElse(projects, () => []).find((candidate) => candidate.id === projectId)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{m.panel_workspace_root()}</p>
      {project && (
        <>
          <p className="font-mono text-xs break-all text-muted-foreground">{project.rootPath}</p>
          <RevealButton path={project.rootPath} />
        </>
      )}
    </div>
  )
}

const statusLabel = {
  preparing: m.worktree_status_preparing,
  ready: m.worktree_status_ready,
  failed: m.worktree_status_failed,
  removed: m.worktree_status_removed,
} satisfies Record<WorktreeStatus, () => string>

const statusVariant = {
  preparing: "outline",
  ready: "secondary",
  failed: "destructive",
  removed: "ghost",
} as const satisfies Record<WorktreeStatus, string>

function WorktreeWorkspace({ worktree }: { worktree: Worktree }) {
  const removed = worktree.status === "removed"
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <RiGitBranchLine aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-sm" title={worktree.branch}>
          {worktree.branch}
        </span>
        <Badge variant={statusVariant[worktree.status]} className="ml-auto">
          {statusLabel[worktree.status]()}
        </Badge>
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">{worktree.path}</p>
      {removed && <p className="text-xs text-muted-foreground">{m.panel_removed_hint()}</p>}
      <RevealButton path={worktree.path} disabled={removed} />
      {!removed && <PullRequestLink worktreeId={worktree.id} />}
    </div>
  )
}

const pullRequestStateLabel = {
  OPEN: m.pr_state_open,
  CLOSED: m.pr_state_closed,
  MERGED: m.pr_state_merged,
} satisfies Record<PullRequestState["state"], () => string>

function PullRequestLink({ worktreeId }: { worktreeId: string }) {
  const pullRequest = AsyncResult.getOrElse(useAtomValue(pullRequestAtom(worktreeId)), () => null)
  if (!pullRequest) return null
  return (
    <div className="flex flex-col gap-1">
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 self-start text-xs text-primary underline-offset-4 hover:underline"
      >
        {m.panel_pr({ state: pullRequestStateLabel[pullRequest.state]() })}
        <RiExternalLinkLine aria-hidden />
      </a>
      {pullRequest.state === "MERGED" && <p className="text-xs text-muted-foreground">{m.panel_pr_merged_hint()}</p>}
    </div>
  )
}

function ChangesSection({ worktree }: { worktree: Worktree | undefined }) {
  if (!worktree) {
    return (
      <Section title={m.panel_changes()}>
        <p className="text-xs text-muted-foreground">{m.panel_changes_root()}</p>
      </Section>
    )
  }
  if (worktree.status === "removed") {
    return (
      <Section title={m.panel_changes()}>
        <p className="text-xs text-muted-foreground">{m.panel_changes_removed()}</p>
      </Section>
    )
  }
  return <WorktreeChanges worktreeId={worktree.id} />
}

const fileStatusLabel = {
  added: m.file_status_added,
  modified: m.file_status_modified,
  deleted: m.file_status_deleted,
  untracked: m.file_status_untracked,
} satisfies Record<ChangedFileStatus, () => string>

const fileStatusMark = {
  added: { letter: "A", className: "text-emerald-500" },
  modified: { letter: "M", className: "text-amber-500" },
  deleted: { letter: "D", className: "text-destructive" },
  untracked: { letter: "U", className: "text-sky-500" },
} satisfies Record<ChangedFileStatus, { letter: string; className: string }>

/** The single-file section of a combined `git diff`, found by its `diff --git a/… b/<path>` header. */
const patchForFile = (patch: string, path: string) =>
  patch.split(/^(?=diff --git )/m).find((chunk) => chunk.slice(0, chunk.indexOf("\n")).endsWith(` b/${path}`))

function WorktreeChanges({ worktreeId }: { worktreeId: string }) {
  const changesAtom = worktreeChangesAtom(worktreeId)
  const changes = useAtomValue(changesAtom)
  const refresh = useAtomRefresh(changesAtom)
  const [openPath, setOpenPath] = useState<string | null>(null)

  const refreshButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={m.panel_changes_refresh()}
      title={m.panel_changes_refresh()}
      onClick={refresh}
    >
      <RiRefreshLine aria-hidden className={changes.waiting ? "animate-spin motion-reduce:animate-none" : undefined} />
    </Button>
  )

  return (
    <Section title={m.panel_changes()} action={refreshButton}>
      {AsyncResult.builder(changes)
        .onInitial(() => <p className="text-xs text-muted-foreground">{m.panel_changes_loading()}</p>)
        .onSuccess(({ baseRef, files, patch }) => (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{m.panel_changes_base({ baseRef })}</p>
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
          <p role="alert" className="text-xs text-destructive">
            {m.panel_changes_failed({ message: error.message })}
          </p>
        ))
        .orElse(() => null)}
    </Section>
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
  const filePatch = open ? patchForFile(patch, path) : undefined

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
          {filePatch ? (
            <PatchDiff
              patch={filePatch}
              options={{ diffStyle: "unified", themeType: "dark", overflow: "wrap", disableFileHeader: true }}
            />
          ) : (
            <p className="p-2 text-muted-foreground">{m.panel_diff_missing()}</p>
          )}
        </div>
      )}
    </li>
  )
}

function SettleControl({ thread, worktree }: { thread: Thread; worktree: Worktree | undefined }) {
  const [open, setOpen] = useState(false)
  const activeWorktree = worktree && worktree.status !== "removed" ? worktree : undefined

  const [error, settle, isPending] = useActionState(async () => {
    try {
      useThreads.getState().upsert(await callPromise("threads.settle", { threadId: thread.id }))
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
    setOpen(false)
    return null
  }, null)

  if (thread.status === "settled" && !activeWorktree) {
    return <p className="text-xs text-muted-foreground">{m.panel_settled()}</p>
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant={activeWorktree ? "destructive" : "outline"} className="w-full" />}>
        {activeWorktree ? m.panel_settle_cleanup() : m.panel_settle()}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.settle_dialog_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {activeWorktree ? m.settle_dialog_worktree({ path: activeWorktree.path }) : m.settle_dialog_root()}
          </AlertDialogDescription>
          {activeWorktree && (
            <AlertDialogDescription>
              {m.settle_dialog_branch({ branch: activeWorktree.branch, baseRef: activeWorktree.baseRef })}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {m.common_error({ message: error })}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant={activeWorktree ? "destructive" : "default"}
            disabled={isPending}
            onClick={() => startTransition(settle)}
          >
            {activeWorktree ? m.settle_dialog_confirm_worktree() : m.settle_dialog_confirm_root()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
