import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { type ReactNode, type RefObject, useId } from "react"
import { RiFolderOpenLine, RiGitBranchLine, RiGitPullRequestLine, RiSideBarFill } from "react-icons/ri"
import type { PullRequest, Thread, Worktree, WorktreeStatus } from "../../shared/domain.ts"
import { branchPullRequestAtom, callPromise, projectsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { ThreadAgents, useRunningSubagentCount } from "./ThreadAgents.tsx"
import { ThreadDiff } from "./ThreadDiff.tsx"
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
 * Right-hand panel of the thread route. Details: where the thread runs, its setup log and ports. Diff: what
 * it changed. PR: its pull requests. Agents: the sub-agents its agent spawned.
 */
export function ThreadSidePanel({ thread, compact = false }: { thread: Thread; compact?: boolean }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const toggleSidePanel = useUi((state) => state.toggleSidePanel)
  const [sectionsRef] = useAutoAnimate<HTMLDivElement>({ duration: 150 })

  return (
    <aside
      ref={returnFocusToComposer}
      aria-label={m.panel_label()}
      className={compact ? "flex min-h-0 w-full flex-1 flex-col" : "flex w-96 shrink-0 flex-col border-l border-border"}
    >
      <Tabs defaultValue="details" className="min-h-0 flex-1 gap-0">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <TabsList>
            <TabsTrigger value="details">{m.panel_tab_details()}</TabsTrigger>
            <TabsTrigger value="diff">{m.panel_tab_diff()}</TabsTrigger>
            <TabsTrigger value="pr">{m.panel_tab_pr()}</TabsTrigger>
            <TabsTrigger value="agents">
              {m.panel_tab_agents()}
              <RunningSubagentsBadge threadId={thread.id} />
            </TabsTrigger>
          </TabsList>
          <PanelToggle expanded onToggle={toggleSidePanel} closeDialog={compact} />
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
              <Section title={m.ports_title()}>
                <ThreadPorts threadId={thread.id} />
              </Section>
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="diff" className="flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <ThreadDiff thread={thread} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="pr" className="flex min-h-0 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <ThreadPullRequests thread={thread} />
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

export function PanelToggle({
  expanded,
  onToggle,
  buttonRef,
  closeDialog = false,
}: {
  expanded: boolean
  onToggle: () => void
  buttonRef?: RefObject<HTMLButtonElement | null>
  closeDialog?: boolean
}) {
  const label = expanded ? m.panel_hide() : m.panel_show()
  const button = (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={closeDialog ? undefined : onToggle}
    >
      <RiSideBarFill aria-hidden className="-scale-x-100" />
    </Button>
  )
  return closeDialog ? <DialogPrimitive.Close render={button} /> : button
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
