import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { PatchDiff } from "@pierre/diffs/react"
import { AsyncResult } from "effect/reactivity"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { type ReactNode, useId, useState } from "react"
import { RiFolderOpenLine, RiGitBranchLine, RiGitPullRequestLine, RiRefreshLine, RiSideBarLine } from "react-icons/ri"
import type { ChangedFileStatus, PullRequestState, Thread, Worktree, WorktreeStatus } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, projectsAtom, pullRequestAtom, worktreeChangesAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useWorktrees } from "../stores/worktrees.ts"
import { SettleDialog, useActiveWorktree } from "./SettleDialog.tsx"
import { ThreadPorts } from "./ThreadPorts.tsx"
import { ThreadPullRequests } from "./ThreadPullRequests.tsx"
import { WorktreeSetupLog } from "./WorktreeSetupLog.tsx"
import { AlertDialogTrigger } from "./ui/alert-dialog.tsx"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

/** Right-hand panel of the thread route: where the thread runs, its setup log, changes, ports, pull requests, and settling. */
export function ThreadSidePanel({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const [sectionsRef] = useAutoAnimate<HTMLDivElement>({ duration: 150 })

  return (
    <aside aria-label={m.panel_label()} className="flex w-80 shrink-0 flex-col border-l border-border">
      <ScrollArea className="min-h-0 flex-1">
        <div ref={sectionsRef} className="flex flex-col gap-7 px-5 py-5">
          <Section title={m.panel_workspace()}>
            {worktree ? <WorktreeWorkspace worktree={worktree} /> : <RootWorkspace projectId={thread.projectId} />}
          </Section>
          {worktree && (
            <Section title={m.panel_setup_log()}>
              <WorktreeSetupLog worktree={worktree} />
            </Section>
          )}
          <ChangesSection worktree={worktree} />
          <Section title={m.ports_title()}>
            <ThreadPorts threadId={thread.id} />
          </Section>
          <Section title={m.pr_links_title()}>
            <ThreadPullRequests threadId={thread.id} />
          </Section>
        </div>
      </ScrollArea>
      <footer className="shrink-0 px-5 pt-2 pb-5">
        <SettleControl thread={thread} />
      </footer>
    </aside>
  )
}

export function PanelToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const label = expanded ? m.panel_hide() : m.panel_show()
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={onToggle}
      className="text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground"
    >
      <RiSideBarLine aria-hidden className="-scale-x-100" />
    </Button>
  )
}

interface SectionProps {
  readonly title: string
  readonly count?: number
  readonly action?: ReactNode
  readonly children: ReactNode
}

function Section({ title, count, action, children }: SectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 id={headingId} className="flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground">
          {title}
          {count !== undefined && count > 0 && (
            <span className="font-normal text-muted-foreground/70 tabular-nums">{count}</span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Long paths keep their informative end: the ellipsis eats the start. `bdi` stops the RTL trick from reordering slashes. */
function PathLine({ path }: { path: string }) {
  return (
    <p className="truncate text-left font-mono text-[11px] text-muted-foreground [direction:rtl]" title={path}>
      <bdi>{path}</bdi>
    </p>
  )
}

function RevealButton({ path, disabled }: { path: string; disabled?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="-ml-2 self-start text-muted-foreground"
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
    <div className="flex flex-col gap-1">
      <p className="text-sm">{m.panel_workspace_root()}</p>
      {project && (
        <>
          <PathLine path={project.rootPath} />
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
  ready: "outline",
  failed: "destructive",
  removed: "ghost",
} as const satisfies Record<WorktreeStatus, string>

function WorktreeWorkspace({ worktree }: { worktree: Worktree }) {
  const removed = worktree.status === "removed"
  const pullRequest = useBranchPullRequest(removed ? undefined : worktree.id)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <RiGitBranchLine aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs" title={worktree.branch}>
          {worktree.branch}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {pullRequest && <PullRequestBadge pullRequest={pullRequest} />}
          <Badge variant={statusVariant[worktree.status]}>{statusLabel[worktree.status]()}</Badge>
        </span>
      </div>
      <PathLine path={worktree.path} />
      {removed && <p className="text-xs text-muted-foreground">{m.panel_removed_hint()}</p>}
      {pullRequest?.state === "MERGED" && <p className="text-xs text-muted-foreground">{m.panel_pr_merged_hint()}</p>}
      <RevealButton path={worktree.path} disabled={removed} />
    </div>
  )
}

const pullRequestStateLabel = {
  OPEN: m.pr_state_open,
  CLOSED: m.pr_state_closed,
  MERGED: m.pr_state_merged,
} satisfies Record<PullRequestState["state"], () => string>

function PullRequestBadge({ pullRequest }: { pullRequest: PullRequestState }) {
  const label = m.panel_pr_badge({ state: pullRequestStateLabel[pullRequest.state]() })
  return (
    <Badge
      variant={pullRequest.state === "MERGED" ? "default" : "outline"}
      render={<a href={pullRequest.url} target="_blank" rel="noreferrer" title={pullRequest.url} aria-label={label} />}
    >
      <RiGitPullRequestLine aria-hidden />
      {label}
    </Badge>
  )
}

/** The GitHub pull request for the worktree's branch, or null when there is none or `gh` cannot tell. */
const useBranchPullRequest = (worktreeId: string | undefined) =>
  AsyncResult.getOrElse(useAtomValue(pullRequestAtom(worktreeId ?? null)), () => null)

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
  added: { letter: "A", className: "text-success" },
  modified: { letter: "M", className: "text-muted-foreground" },
  deleted: { letter: "D", className: "text-destructive" },
  untracked: { letter: "U", className: "text-success" },
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
    <Section
      title={m.panel_changes()}
      count={AsyncResult.getOrElse(changes, () => undefined)?.files.length}
      action={refreshButton}
    >
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
            {m.panel_changes_failed({ message: errorMessage(error) })}
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
  const slash = path.lastIndexOf("/")
  const name = path.slice(slash + 1)
  const dir = path.slice(0, Math.max(slash, 0))
  const filePatch = open ? patchForFile(patch, path) : undefined

  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={diffId}
        onClick={onToggle}
        title={path}
        className="-mx-2 flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
      >
        <abbr
          title={fileStatusLabel[status]()}
          className={`w-2.5 shrink-0 font-mono text-[11px] no-underline ${mark.className}`}
        >
          {mark.letter}
        </abbr>
        <span className="shrink-0 truncate">{name}</span>
        <span className="min-w-0 truncate text-muted-foreground/80">{dir}</span>
      </button>
      {open && (
        <div id={diffId} className="mb-1 overflow-hidden rounded-md border border-border text-xs">
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

function SettleControl({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false)
  const worktree = useActiveWorktree(thread)
  const merged = useBranchPullRequest(worktree?.id)?.state === "MERGED"

  if (thread.status === "settled" && !worktree) {
    return <p className="text-xs text-muted-foreground">{m.panel_settled()}</p>
  }

  // Once the branch is merged, deleting the worktree loses nothing, so cleanup becomes the primary action.
  const variant = worktree && merged ? "default" : "outline"
  return (
    <SettleDialog thread={thread} open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant={variant}
            className={worktree && !merged ? "w-full text-destructive hover:text-destructive" : "w-full"}
          />
        }
      >
        {worktree ? m.panel_settle_cleanup() : m.panel_settle()}
      </AlertDialogTrigger>
    </SettleDialog>
  )
}
