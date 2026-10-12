import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { AsyncResult } from "effect/reactivity"
import { useState, useTransition } from "react"
import type { IconType } from "react-icons"
import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiLinkUnlinkM,
  RiTimeLine,
} from "react-icons/ri"
import type {
  ChecksStatus,
  PullRequest,
  PullRequestLink,
  PullRequestStatus,
  ReviewStatus,
  Thread,
} from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { branchPullRequestAtom, callPromise, gitHubAuthAtom, pullRequestStatusAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { loadPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { Button } from "./ui/button.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"

/** "owner/repo#123" for a canonical GitHub pull request URL. */
const shortName = (url: string) => {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)
  return match ? `${match[1]}#${match[2]}` : url
}

export const pullRequestStatusLabel = {
  draft: m.pr_state_draft,
  open: m.pr_state_open,
  merged: m.pr_state_merged,
  closed: m.pr_state_closed,
} satisfies Record<PullRequestStatus, () => string>

const statusColor = {
  draft: "text-muted-foreground",
  open: "text-emerald-500",
  merged: "text-violet-500",
  closed: "text-destructive",
} satisfies Record<PullRequestStatus, string>

const reviewLabel = {
  approved: m.pr_review_approved,
  changesRequested: m.pr_review_changes_requested,
  reviewRequired: m.pr_review_required,
} satisfies Record<ReviewStatus, () => string>

const checksIndicator = {
  passing: { Icon: RiCheckboxCircleFill, className: "text-emerald-500", label: m.pr_checks_passing },
  failing: { Icon: RiCloseCircleFill, className: "text-destructive", label: m.pr_checks_failing },
  pending: { Icon: RiTimeLine, className: "text-amber-500", label: m.pr_checks_pending },
} satisfies Record<ChecksStatus, { Icon: IconType; className: string; label: () => string }>

/** Pull requests linked to the thread, as the body of a panel section. Updates live. */
export function ThreadPullRequests({ thread }: { thread: Thread }) {
  const threadId = thread.id
  const loadAtom = loadPullRequestsAtom(threadId)
  const load = useAtomValue(loadAtom)
  const reload = useAtomRefresh(loadAtom)
  const links = usePullRequests((state) => state.byThreadId[threadId])
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  if (!links) {
    return AsyncResult.builder(load)
      .onError((error) => (
        <div role="alert" className="flex items-center gap-2">
          <p className="text-xs text-destructive">{m.pr_links_failed({ message: errorMessage(error) })}</p>
          <Button variant="outline" size="xs" onClick={reload}>
            {m.common_retry()}
          </Button>
        </div>
      ))
      .orElse(() => <SkeletonList label={m.pr_links_loading()} rows={1} rowClassName="h-4" />)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {links.length === 0 ? (
        <p className="text-xs text-muted-foreground">{m.pr_links_empty()}</p>
      ) : (
        <ul ref={listRef} className="flex flex-col">
          {links.map((link) => (
            <PullRequestRow key={link.id} link={link} onUnlinkFailed={setUnlinkError} />
          ))}
        </ul>
      )}
      {unlinkError && (
        <p role="alert" className="text-xs text-destructive">
          {unlinkError}
        </p>
      )}
      <CreatePullRequest thread={thread} />
      <GitHubAuthHint />
    </div>
  )
}

function CreatePullRequest({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  if (worktree?.status !== "ready") return null
  return <CreatePullRequestButton threadId={thread.id} worktreeId={worktree.id} />
}

/** Offered only when `gh` is signed in and the branch has no pull request yet. */
function CreatePullRequestButton({ threadId, worktreeId }: { threadId: string; worktreeId: string }) {
  const branchAtom = branchPullRequestAtom(worktreeId)
  const branchPullRequest = useAtomValue(branchAtom)
  const refreshBranchPullRequest = useAtomRefresh(branchAtom)
  const auth = useAtomValue(gitHubAuthAtom)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const hasNoPullRequest = AsyncResult.isSuccess(branchPullRequest) && branchPullRequest.value === null
  const signedIn = AsyncResult.isSuccess(auth) && auth.value.type === "signedIn"
  if (!hasNoPullRequest || !signedIn) return null

  // The new link arrives through the thread's pull request push; only the branch lookup needs asking again.
  const create = () =>
    startTransition(async () => {
      setError(null)
      try {
        await callPromise("pullRequests.create", { threadId })
        refreshBranchPullRequest()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="outline" size="xs" className="self-start" disabled={pending} onClick={create}>
        <RiGitPullRequestLine aria-hidden />
        {pending ? m.pr_creating() : m.pr_create()}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function GitHubAuthHint() {
  const auth = useAtomValue(gitHubAuthAtom)
  if (!AsyncResult.isSuccess(auth)) return null
  switch (auth.value.type) {
    case "missing":
      return <p className="text-xs text-muted-foreground">{m.pr_gh_missing()}</p>
    case "signedOut":
      return (
        <p className="text-xs text-muted-foreground">
          {m.pr_gh_signed_out_before()} <code className="font-mono text-foreground">gh auth login</code>{" "}
          {m.pr_gh_signed_out_after()}
        </p>
      )
    case "signedIn":
      return null
  }
}

interface PullRequestRowProps {
  readonly link: PullRequestLink
  readonly onUnlinkFailed: (message: string | null) => void
}

function PullRequestRow({ link, onUnlinkFailed }: PullRequestRowProps) {
  const [pending, startTransition] = useTransition()
  const status = useAtomValue(pullRequestStatusAtom(link.url))
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom), () => null)?.type === "signedIn"
  const pullRequest = AsyncResult.isSuccess(status) ? status.value : undefined
  const name = shortName(link.url)

  // The row disappears when main pushes the updated list, so success needs no handling here.
  const unlink = () =>
    startTransition(async () => {
      try {
        await callPromise("pullRequests.unlink", { threadId: link.threadId, url: link.url })
        onUnlinkFailed(null)
      } catch (cause) {
        onUnlinkFailed(errorMessage(cause))
      }
    })

  return (
    <li className="flex flex-col py-0.5 text-xs">
      <div className="flex items-center gap-2">
        <RiGitPullRequestLine
          aria-hidden
          className={cn("size-3.5 shrink-0", pullRequest ? statusColor[pullRequest.status] : "text-muted-foreground")}
        />
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          title={link.url}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm font-mono underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{name}</span>
          <RiExternalLinkLine aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </a>
        {pullRequest?.checks && <ChecksIndicator checks={pullRequest.checks} />}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={m.pr_links_unlink({ name })}
          title={m.pr_links_unlink({ name })}
          disabled={pending}
          onClick={unlink}
        >
          <RiLinkUnlinkM aria-hidden />
        </Button>
      </div>
      {AsyncResult.builder(status)
        .onSuccess((details) => (
          <p className="truncate pl-5.5 text-muted-foreground" title={details.title}>
            {pullRequestSummary(details)}
          </p>
        ))
        .onError((error) =>
          // Without a gh login every row fails the same way; the section hint explains it once.
          signedIn ? <p className="truncate pl-5.5 text-destructive/80">{errorMessage(error)}</p> : null,
        )
        .orElse(() => null)}
    </li>
  )
}

// Status leads so a long title truncates instead of hiding it.
const pullRequestSummary = ({ title, status, review }: PullRequest) =>
  [pullRequestStatusLabel[status](), review && reviewLabel[review](), title].filter(Boolean).join(" · ")

function ChecksIndicator({ checks }: { checks: ChecksStatus }) {
  const { Icon, className, label } = checksIndicator[checks]
  return (
    <span title={label()} className="flex shrink-0">
      <Icon aria-hidden className={cn("size-3.5", className)} />
      <span className="sr-only">{label()}</span>
    </span>
  )
}
