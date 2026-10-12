import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { PatchDiff } from "@pierre/diffs/react"
import { AsyncResult } from "effect/reactivity"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { type ReactNode, useId, useState } from "react"
import { RiFolderOpenLine, RiGitBranchLine, RiGitPullRequestLine, RiRefreshLine, RiSideBarFill } from "react-icons/ri"
import {
  type ChangedFileStatus,
  type PullRequest,
  type Thread,
  type Worktree,
  type WorktreeStatus,
} from "../../shared/domain.ts"
import { themes } from "../lib/appearance.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { branchPullRequestAtom, callPromise, projectsAtom, worktreeChangesAtom } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { ThreadAgents, useRunningSubagentCount } from "./ThreadAgents.tsx"
import { ThreadPorts } from "./ThreadPorts.tsx"
import { pullRequestStatusLabel, ThreadPullRequests } from "./ThreadPullRequests.tsx"
import { WorktreeSetupLog } from "./WorktreeSetupLog.tsx"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx"

/** Hiding the panel (mod+.) takes the focused element with it; hand focus to the composer instead of <body>. */
const returnFocusToComposer = (panel: HTMLElement | null) => () => {
  if (panel?.contains(document.activeElement)) useUi.getState().requestComposerFocus()
}

/**
 * Right-hand panel of the thread route. Details: where the thread runs, its setup log, changes, ports
 * and pull requests. Agents: the sub-agents its agent spawned.
 */
export function ThreadSidePanel({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const toggleSidePanel = useUi((state) => state.toggleSidePanel)
  const [sectionsRef] = useAutoAnimate<HTMLDivElement>({ duration: 150 })

  return (
    <aside
      ref={returnFocusToComposer}
      aria-label={m.panel_label()}
      className="flex w-96 shrink-0 flex-col border-l border-border"
    >
      <Tabs defaultValue="details" className="min-h-0 flex-1 gap-0">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <TabsList>
            <TabsTrigger value="details">{m.panel_tab_details()}</TabsTrigger>
            <TabsTrigger value="agents">
              {m.panel_tab_agents()}
              <RunningSubagentsBadge threadId={thread.id} />
            </TabsTrigger>
          </TabsList>
          <PanelToggle expanded onToggle={toggleSidePanel} />
        </header>
        <TabsContent value="details" className="flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div ref={sectionsRef} className="flex flex-col gap-6 p-4">
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
                <ThreadPullRequests thread={thread} />
              </Section>
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="agents" className="flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <ThreadAgents threadId={thread.id} />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  )
}

function RunningSubagentsBadge({ threadId }: { threadId: string }) {
  const running = useRunningSubagentCount(threadId)
  if (running === 0) return null
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-working/15 px-1 text-[0.6875rem] font-medium text-working tabular-nums">
      <span aria-hidden>{running}</span>
      <span className="sr-only">{m.agents_running_count({ count: running })}</span>
    </span>
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
  const pullRequest = useBranchPullRequest(removed ? undefined : worktree.id)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <RiGitBranchLine aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-sm" title={worktree.branch}>
          {worktree.branch}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {pullRequest && <PullRequestBadge pullRequest={pullRequest} />}
          <Badge variant={statusVariant[worktree.status]}>{statusLabel[worktree.status]()}</Badge>
        </span>
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">{worktree.path}</p>
      {removed && <p className="text-xs text-muted-foreground">{m.panel_removed_hint()}</p>}
      {pullRequest?.status === "merged" && <p className="text-xs text-muted-foreground">{m.panel_pr_merged_hint()}</p>}
      <RevealButton path={worktree.path} disabled={removed} />
    </div>
  )
}

function PullRequestBadge({ pullRequest }: { pullRequest: PullRequest }) {
  const label = m.panel_pr_badge({ state: pullRequestStatusLabel[pullRequest.status]() })
  return (
    <Badge
      variant={pullRequest.status === "merged" ? "default" : "outline"}
      render={<a href={pullRequest.url} target="_blank" rel="noreferrer" title={pullRequest.url} aria-label={label} />}
    >
      <RiGitPullRequestLine aria-hidden />
      {label}
    </Badge>
  )
}

/** The GitHub pull request for the worktree's branch, or null when there is none or `gh` cannot tell. */
const useBranchPullRequest = (worktreeId: string | undefined) =>
  AsyncResult.getOrElse(useAtomValue(branchPullRequestAtom(worktreeId ?? null)), () => null)

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
  const filePatch = open ? patchForFile(patch, path) : undefined
  const theme = themes[useSettings().appearance.theme]

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
              options={{
                diffStyle: "unified",
                theme: theme.codeTheme,
                themeType: theme.scheme,
                overflow: "wrap",
                disableFileHeader: true,
              }}
            />
          ) : (
            <p className="p-2 text-muted-foreground">{m.panel_diff_missing()}</p>
          )}
        </div>
      )}
    </li>
  )
}
