import { useAtomValue } from "@effect/atom-react"
import { startTransition, useState, useTransition } from "react"
import { codeHostOfUrl, parseGitLabMergeRequestUrl, pullRequestNumberLabel } from "../../shared/codeHost.ts"
import type { MergeMethod, PullRequest, PullRequestLink } from "../../shared/domain.ts"
import { usePullRequestHref } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { parsePullRequestUrl } from "../lib/pullRequestRefs.ts"
import { callPromise, type EnvironmentId, pullRequestStatusesAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { PullRequestCard } from "./PullRequestLink.tsx"
import {
  ChecksIndicator,
  mergeLabel,
  mergeMethodsFor,
  offeredMergeMethod,
  StatusIcon,
  statusIndicator,
} from "./ThreadPullRequests.tsx"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx"
import { Button } from "./ui/button.tsx"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"
import { StackIcon } from "@hinacode/icons"

const numberLabelOfUrl = (url: string) => {
  const mergeRequest = parseGitLabMergeRequestUrl(url)
  return mergeRequest ? pullRequestNumberLabel("gitlab", mergeRequest.iid) : `#${/\/pull\/(\d+)/.exec(url)?.[1] ?? ""}`
}
const numberLabel = (pullRequest: PullRequest) =>
  pullRequestNumberLabel(codeHostOfUrl(pullRequest.url), pullRequest.number)
const canMerge = (pullRequest: PullRequest | undefined): pullRequest is PullRequest =>
  pullRequest?.status === "open" && pullRequest.mergeable !== "conflicting"

const aboveRowLinkTrigger =
  "relative z-10 flex shrink-0 items-center gap-0.5 rounded-sm font-mono underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-sidebar-ring"

export function SidebarPullRequests({
  threadId,
  links,
  environment,
}: {
  threadId: string
  links: ReadonlyArray<PullRequestLink>
  environment: EnvironmentId
}) {
  const urls = links.map((link) => link.url)
  const pullRequests = useAtomValue(pullRequestStatusesAtom(environment, urls))
  const [merging, setMerging] = useState<ReadonlyArray<PullRequest>>([])
  const [mergeOpen, setMergeOpen] = useState(false)
  const merge = (oldestFirst: ReadonlyArray<PullRequest>) => {
    setMerging(oldestFirst)
    setMergeOpen(true)
  }
  const mergeable = pullRequests.filter(canMerge)

  return (
    <>
      {links.length === 1 ? (
        <SinglePullRequest
          threadId={threadId}
          url={urls[0]!}
          pullRequest={pullRequests[0]}
          environment={environment}
          merge={merge}
        />
      ) : (
        <HoverCard>
          <HoverCardTrigger
            render={<button type="button" aria-label={m.sidebar_pull_request_stack({ count: String(links.length) })} />}
            delay={300}
            className={cn(aboveRowLinkTrigger, "text-muted-foreground hover:text-foreground")}
          >
            <StackIcon aria-hidden className="size-3" />+{links.length}
          </HoverCardTrigger>
          <HoverCardContent align="start" className="flex w-80 flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {m.sidebar_pull_request_stack({ count: String(links.length) })}
            </p>
            <ul className="flex flex-col gap-0.5">
              {urls.map((url, index) => (
                <StackRow key={url} threadId={threadId} url={url} pullRequest={pullRequests[index]} merge={merge} />
              ))}
            </ul>
            {mergeable.length > 1 && (
              <Button size="xs" className="self-end" action={() => merge(mergeable)}>
                {m.sidebar_pr_merge_all({ count: String(mergeable.length) })}
              </Button>
            )}
          </HoverCardContent>
        </HoverCard>
      )}
      <MergeDialog oldestFirst={merging} environment={environment} open={mergeOpen} onOpenChange={setMergeOpen} />
    </>
  )
}

function SinglePullRequest({
  threadId,
  url,
  pullRequest,
  environment,
  merge,
}: {
  threadId: string
  url: string
  pullRequest: PullRequest | undefined
  environment: EnvironmentId
  merge: (pullRequests: ReadonlyArray<PullRequest>) => void
}) {
  const number = numberLabelOfUrl(url)
  const pullRequestRef = parsePullRequestUrl(url)
  const href = usePullRequestHref(threadId, url)
  const status = pullRequest?.status
  return (
    <HoverCard>
      <HoverCardTrigger
        href={href}
        target="_blank"
        rel="noreferrer"
        delay={300}
        aria-label={m.sidebar_pull_request({ number })}
        className={cn(
          aboveRowLinkTrigger,
          status ? statusIndicator[status].className : "text-muted-foreground hover:text-foreground",
        )}
      >
        <StatusIcon status={status} className="size-3" />
        {number}
      </HoverCardTrigger>
      {(pullRequestRef || pullRequest) && (
        <HoverCardContent align="start" className="flex w-80 flex-col gap-2">
          {pullRequestRef ? (
            <PullRequestCard pullRequest={pullRequestRef} href={href} environment={environment} />
          ) : (
            <p className="text-xs font-medium">{pullRequest?.title}</p>
          )}
          {canMerge(pullRequest) && (
            <Button size="xs" className="self-end" action={() => merge([pullRequest])}>
              {m.sidebar_pr_merge()}
            </Button>
          )}
        </HoverCardContent>
      )}
    </HoverCard>
  )
}

function StackRow({
  threadId,
  url,
  pullRequest,
  merge,
}: {
  threadId: string
  url: string
  pullRequest: PullRequest | undefined
  merge: (pullRequests: ReadonlyArray<PullRequest>) => void
}) {
  const href = usePullRequestHref(threadId, url)
  const number = numberLabelOfUrl(url)
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      <StatusIcon status={pullRequest?.status} colored />
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 rounded-sm font-mono text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {number}
      </a>
      <span className="min-w-0 flex-1 truncate" title={pullRequest?.title}>
        {pullRequest?.title}
      </span>
      {pullRequest?.checks && <ChecksIndicator checks={pullRequest.checks} />}
      {canMerge(pullRequest) && (
        <Button
          variant="outline"
          size="xs"
          aria-label={m.sidebar_pr_merge_number({ number })}
          action={() => merge([pullRequest])}
        >
          {m.sidebar_pr_merge()}
        </Button>
      )}
    </li>
  )
}

function MergeDialog({
  oldestFirst,
  environment,
  open,
  onOpenChange,
}: {
  oldestFirst: ReadonlyArray<PullRequest>
  environment: EnvironmentId
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const mergeMethods = mergeMethodsFor(
    oldestFirst.some((pullRequest) => codeHostOfUrl(pullRequest.url) === "gitlab") ? "gitlab" : "github",
  )
  const [chosenMethod, setMethod] = useState<MergeMethod>("squash")
  const method = offeredMergeMethod(chosenMethod, mergeMethods)
  const [pending, startMerge] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const first = oldestFirst[0]
  const several = oldestFirst.length > 1

  const confirm = () =>
    startMerge(async () => {
      setError(null)
      for (const pullRequest of oldestFirst) {
        try {
          await callPromise("github.merge", { url: pullRequest.url, method }, { environment })
        } catch (cause) {
          setError(m.sidebar_pr_merge_failed({ number: numberLabel(pullRequest), message: errorMessage(cause) }))
          return
        }
      }
      onOpenChange(false)
    })

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {several
              ? m.sidebar_pr_merge_all_title({ count: oldestFirst.length })
              : m.pr_merge_title({ number: first ? numberLabel(first) : "", method: mergeLabel[method]() })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {several
              ? m.sidebar_pr_merge_all_body()
              : first && m.pr_merge_body({ head: first.headRefName, base: first.baseRefName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {several && (
          <ul className="flex flex-col gap-1 text-sm">
            {oldestFirst.map((pullRequest) => (
              <li key={pullRequest.url} className="flex min-w-0 flex-col">
                <span className="truncate">
                  <span className="font-mono text-muted-foreground">{numberLabel(pullRequest)}</span>{" "}
                  {pullRequest.title}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {`${pullRequest.headRefName} → ${pullRequest.baseRefName}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Select
          items={mergeMethods.map((value) => ({ value, label: mergeLabel[value]() }))}
          value={method}
          onValueChange={(next) => next && startTransition(() => setMethod(next))}
        >
          <SelectTrigger aria-label={m.pr_merge_method()} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {mergeMethods.map((value) => (
              <SelectItem key={value} value={value}>
                {mergeLabel[value]()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={confirm}>
            {mergeLabel[method]()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
