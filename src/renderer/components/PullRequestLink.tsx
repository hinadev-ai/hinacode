import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ReactNode } from "react"
import { RiGithubFill } from "react-icons/ri"
import type { PullRequest } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import type { PullRequestRef } from "../lib/pullRequestRefs.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { pullRequestStatusAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import {
  checksIndicator,
  pullRequestStatusLabel,
  reviewLabel,
  StatusIcon,
  statusIndicator,
} from "./ThreadPullRequests.tsx"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card.tsx"
import { Skeleton } from "./ui/skeleton.tsx"

/**
 * A link to a GitHub pull request. Hovering or focusing it shows the pull request at a glance; `gh` is
 * only asked once the card opens.
 */
export function PullRequestLink({
  href,
  pullRequest,
  children,
}: {
  href: string
  pullRequest: PullRequestRef
  children: ReactNode
}) {
  return (
    <HoverCard>
      {/* target=_blank routes the click through the main process, which opens it in the system browser. */}
      <HoverCardTrigger
        href={href}
        target="_blank"
        rel="noreferrer"
        delay={300}
        className="text-primary underline underline-offset-2"
      >
        <RiGithubFill aria-hidden className="mr-1 inline-block size-3.5 align-[-0.125em]" />
        {children}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <PullRequestCard pullRequest={pullRequest} />
      </HoverCardContent>
    </HoverCard>
  )
}

function PullRequestCard({ pullRequest: { owner, name, number } }: { pullRequest: PullRequestRef }) {
  // The canonical url, so links to a pull request's files or comments share one lookup.
  const environment = useOpenThreadEnvironment()
  const status = useAtomValue(pullRequestStatusAtom(environment, `https://github.com/${owner}/${name}/pull/${number}`))
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p className="text-muted-foreground">
        {owner}/{name} #{number}
      </p>
      {AsyncResult.builder(status)
        .onSuccess((details) => <PullRequestDetails pullRequest={details} />)
        .onError((error) => (
          <p className="text-muted-foreground" title={errorMessage(error)}>
            {m.pr_card_failed()}
          </p>
        ))
        .orElse(() => (
          <output aria-label={m.pr_card_loading()} className="flex animate-reveal flex-col gap-1.5">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </output>
        ))}
    </div>
  )
}

function PullRequestDetails({ pullRequest }: { pullRequest: PullRequest }) {
  const { title, status, checks, review, author, headRefName, baseRefName, additions, deletions } = pullRequest
  const checksStatus = checks && checksIndicator[checks]
  return (
    <>
      <p className="line-clamp-2 text-sm font-medium">{title}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cn("flex items-center gap-1", statusIndicator[status].className)}>
          <StatusIcon status={status} />
          {pullRequestStatusLabel[status]()}
        </span>
        {checksStatus && (
          <span className="flex items-center gap-1">
            <checksStatus.Icon aria-hidden className={cn("size-3.5", checksStatus.className)} />
            {checksStatus.label()}
          </span>
        )}
        {review && <span className="text-muted-foreground">{reviewLabel[review]()}</span>}
      </div>
      <p className="truncate text-muted-foreground">
        {author} · <span className="font-mono">{`${headRefName} → ${baseRefName}`}</span>
      </p>
      <p className="font-mono">
        <span aria-hidden>
          <span className="text-vcs-added">+{additions}</span> <span className="text-destructive">−{deletions}</span>
        </span>
        <span className="sr-only">{m.pr_card_size({ additions, deletions })}</span>
      </p>
    </>
  )
}
