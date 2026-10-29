import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { RiCloudLine, RiGitBranchLine, RiMacbookLine } from "react-icons/ri"
import type { PullRequest, PullRequestStatus, Thread } from "../../shared/domain.ts"
import { environmentName, useClouds, usePullRequestHref, useThreadEnvironment } from "../lib/environments.ts"
import { currentBranchAtom, pullRequestStatusesAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { usePullRequests } from "../stores/pullRequests.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { StatusIcon, statusIndicator } from "./ThreadPullRequests.tsx"

const statusLabel = {
  draft: m.pr_state_draft,
  open: m.pr_state_open,
  merged: m.pr_state_merged,
  closed: m.pr_state_closed,
} satisfies Record<PullRequestStatus, () => string>

const pullRequestNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? ""

const noLinks: ReadonlyArray<never> = []

/** Where a started thread runs, on which branch, and the pull requests it opened, under its composer. */
export function ComposerStatusLine({ thread }: { thread: Thread }) {
  const environment = useThreadEnvironment(thread.id)
  const clouds = useClouds()
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const rootBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const links = usePullRequests((state) => state.byThreadId[thread.id] ?? noLinks)
  const urls = links.map((link) => link.url)
  const pullRequests = useAtomValue(pullRequestStatusesAtom(environment, urls))
  const branch = worktree?.branch ?? rootBranch
  const EnvironmentIcon = environment === null ? RiMacbookLine : RiCloudLine

  return (
    // The dock floats over the transcript, so this strip and the dock's bottom padding cover what scrolls behind.
    <div className="-mx-3 -mb-3 bg-background px-3 pt-1 pb-3">
      <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-3 px-3 text-xs text-muted-foreground">
        <span className="flex shrink-0 items-center gap-1">
          <EnvironmentIcon aria-hidden className="size-3.5" />
          {environmentName(environment, clouds)}
        </span>
        {branch !== "" && (
          <span className="flex min-w-0 items-center gap-1" title={worktree?.path}>
            <RiGitBranchLine aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{branch}</span>
          </span>
        )}
        {urls.map((url, index) => (
          <PullRequestSummary key={url} threadId={thread.id} url={url} pullRequest={pullRequests[index]} />
        ))}
      </div>
    </div>
  )
}

function PullRequestSummary({
  threadId,
  url,
  pullRequest,
}: {
  threadId: string
  url: string
  pullRequest: PullRequest | undefined
}) {
  const href = usePullRequestHref(threadId, url)
  const status = pullRequest?.status
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex shrink-0 items-center gap-1.5 rounded-sm tabular-nums underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className={cn("flex items-center gap-1", status && statusIndicator[status].className)}>
        <StatusIcon status={status} className="size-3.5" />#{pullRequestNumber(url)}
        {status && <span className="sr-only">{statusLabel[status]()}</span>}
      </span>
      {pullRequest && (
        <span>
          <span className="text-vcs-added">+{pullRequest.additions}</span>{" "}
          <span className="text-destructive">−{pullRequest.deletions}</span>
        </span>
      )}
    </a>
  )
}
