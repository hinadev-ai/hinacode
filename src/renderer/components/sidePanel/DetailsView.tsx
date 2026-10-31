import { useAtomValue } from "@effect/atom-react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import {
  type PullRequest,
  type Thread,
  threadFolder,
  type Worktree,
  type WorktreeStatus,
} from "../../../shared/domain.ts"
import { environmentName, useClouds, usePullRequestHref, useThreadEnvironment } from "../../lib/environments.ts"
import { branchPullRequestAtom, callPromise, projectsAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useWorktrees } from "../../stores/worktrees.ts"
import { ThreadPorts } from "../ThreadPorts.tsx"
import { pullRequestStatusLabel } from "../ThreadPullRequests.tsx"
import { WorktreeSetupLog } from "../WorktreeSetupLog.tsx"
import { Badge } from "../ui/badge.tsx"
import { Button } from "../ui/button.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"
import { Section } from "./Section.tsx"
import { BranchIcon } from "../icons/BranchIcon.tsx"
import { CloudIcon } from "../icons/CloudIcon.tsx"
import { FolderOpenIcon } from "../icons/FolderOpenIcon.tsx"
import { PullRequestIcon } from "../icons/PullRequestIcon.tsx"

/** Where the thread runs, its setup log and the ports its processes listen on. */
export function DetailsView({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const [sectionsRef] = useAutoAnimate<HTMLDivElement>({ duration: 150 })
  const environment = useThreadEnvironment(thread.id)
  const clouds = useClouds()
  const local = environment === null

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div ref={sectionsRef} className="flex flex-col gap-6 p-4">
        <Section title={m.panel_workspace()}>
          {!local && (
            <p className="flex items-center gap-1.5 text-sm">
              <CloudIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {m.environment_on({ environment: environmentName(environment, clouds) })}
            </p>
          )}
          {worktree ? (
            <WorktreeWorkspace worktree={worktree} canReveal={local} />
          ) : (
            <RootWorkspace thread={thread} canReveal={local} />
          )}
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
      <FolderOpenIcon aria-hidden />
      {m.panel_reveal()}
    </Button>
  )
}

function RootWorkspace({ thread, canReveal }: { thread: Thread; canReveal: boolean }) {
  const projects = useAtomValue(projectsAtom)
  const project = AsyncResult.getOrElse(projects, () => []).find((candidate) => candidate.id === thread.projectId)
  const folder = project && threadFolder(project, thread.id)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{m.panel_workspace_root()}</p>
      {folder && (
        <>
          <p className="font-mono text-xs break-all text-muted-foreground">{folder}</p>
          {canReveal && <RevealButton path={folder} />}
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

function WorktreeWorkspace({ worktree, canReveal }: { worktree: Worktree; canReveal: boolean }) {
  const removed = worktree.status === "removed"
  const pullRequest = useBranchPullRequest(removed ? undefined : worktree.id)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <BranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
      {canReveal && <RevealButton path={worktree.path} disabled={removed} />}
    </div>
  )
}

function PullRequestBadge({ pullRequest }: { pullRequest: PullRequest }) {
  const { threadId } = useParams({ strict: false })
  const href = usePullRequestHref(threadId, pullRequest.url)
  const label = m.panel_pr_badge({ state: pullRequestStatusLabel[pullRequest.status]() })
  return (
    <Badge
      variant={pullRequest.status === "merged" ? "default" : "outline"}
      render={<a href={href} target="_blank" rel="noreferrer" title={href} aria-label={label} />}
    >
      <PullRequestIcon aria-hidden />
      {label}
    </Badge>
  )
}

/** The GitHub pull request for the worktree's branch, or null when there is none or `gh` cannot tell. */
const useBranchPullRequest = (worktreeId: string | undefined) =>
  AsyncResult.getOrElse(useAtomValue(branchPullRequestAtom(worktreeId ?? null)), () => null)
