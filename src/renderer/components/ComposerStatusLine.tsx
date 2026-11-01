import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { PullRequest, PullRequestStatus, Thread } from "../../shared/domain.ts"
import { environmentName, useClouds, usePullRequestHref, useThreadEnvironment } from "../lib/environments.ts"
import { currentBranchAtom, pullRequestStatusesAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { usePullRequests } from "../stores/pullRequests.ts"
import { useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { StatusIcon, statusIndicator } from "./ThreadPullRequests.tsx"
import { BranchIcon } from "./icons/BranchIcon.tsx"
import { CloudIcon } from "./icons/CloudIcon.tsx"
import { LaptopIcon } from "./icons/LaptopIcon.tsx"
import { StackIcon } from "./icons/StackIcon.tsx"

const statusLabel = {
  draft: m.pr_state_draft,
  open: m.pr_state_open,
  merged: m.pr_state_merged,
  closed: m.pr_state_closed,
} satisfies Record<PullRequestStatus, () => string>

const pullRequestNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? ""

const noLinks: ReadonlyArray<never> = []

export function ComposerStatusLine({ thread }: { thread: Thread }) {
  const environment = useThreadEnvironment(thread.id)
  const clouds = useClouds()
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const rootBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const links = usePullRequests((state) => state.byThreadId[thread.id] ?? noLinks)
  const urls = links.map((link) => link.url)
  const pullRequests = useAtomValue(pullRequestStatusesAtom(environment, urls))
  const branch = worktree?.branch ?? rootBranch
  const EnvironmentIcon = environment === null ? LaptopIcon : CloudIcon

  return (
    <div className="-mb-3 -ml-3 bg-background pt-1 pb-3 pl-3">
      <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-3 px-3 text-xs text-muted-foreground">
        <span className="flex shrink-0 items-center gap-1">
          <EnvironmentIcon aria-hidden className="size-3 shrink-0 cjk:translate-y-[-0.04em]" />
          {environmentName(environment, clouds)}
        </span>
        {branch !== "" && (
          <span className="flex min-w-0 items-center gap-1" title={worktree?.path}>
            <BranchIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate font-mono">{branch}</span>
          </span>
        )}
        {urls.length === 1 ? (
          <PullRequestSummary threadId={thread.id} url={urls[0]!} pullRequest={pullRequests[0]} />
        ) : (
          urls.length > 1 && (
            <button
              type="button"
              onClick={() => useUi.getState().showView(thread.id, "pullRequests", { focus: true })}
              className="flex shrink-0 items-center gap-1 rounded-sm tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StackIcon aria-hidden className="size-3" />
              <span aria-hidden>{urls.length}</span>
              <span className="sr-only">{m.sidebar_pull_request_stack({ count: String(urls.length) })}</span>
            </button>
          )
        )}
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
        <StatusIcon status={status} className="size-3" />#{pullRequestNumber(url)}
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
