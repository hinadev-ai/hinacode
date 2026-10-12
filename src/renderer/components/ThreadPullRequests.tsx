import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useId, useState, useTransition } from "react"
import type { IconType } from "react-icons"
import {
  RiArrowDownSLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiIndeterminateCircleLine,
  RiLinkUnlinkM,
  RiTimeLine,
} from "react-icons/ri"
import type {
  CheckRunStatus,
  ChecksStatus,
  MergeMethod,
  PullRequest,
  PullRequestDetail,
  PullRequestStatus,
  ReviewStatus,
  Thread,
} from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import {
  branchPullRequestAtom,
  callPromise,
  gitHubAuthAtom,
  pullRequestDetailAtom,
  pullRequestStatusAtom,
} from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { loadPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { Markdown } from "./Markdown.tsx"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
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

const checkRunIndicator = {
  ...checksIndicator,
  skipped: { Icon: RiIndeterminateCircleLine, className: "text-muted-foreground", label: m.pr_check_skipped },
} satisfies Record<CheckRunStatus, { Icon: IconType; className: string; label: () => string }>

const mergeLabel = {
  squash: m.pr_merge_squash,
  merge: m.pr_merge_commit,
  rebase: m.pr_merge_rebase,
} satisfies Record<MergeMethod, () => string>

const isOpen = (status: PullRequestStatus) => status === "open" || status === "draft"

/**
 * The PR tab. Every pull request the thread has: the ones agents linked plus the one GitHub has for the
 * worktree branch. Several show as a list to pick from; the picked one shows in full below.
 */
export function ThreadPullRequests({ thread }: { thread: Thread }) {
  const threadId = thread.id
  const loadAtom = loadPullRequestsAtom(threadId)
  const load = useAtomValue(loadAtom)
  const reload = useAtomRefresh(loadAtom)
  const links = usePullRequests((state) => state.byThreadId[threadId])
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const live = worktree !== undefined && worktree.status !== "removed"
  const branchPullRequest = AsyncResult.getOrElse(
    useAtomValue(branchPullRequestAtom(live ? worktree.id : null)),
    () => null,
  )
  const [picked, setPicked] = useState<string | null>(null)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

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
      .orElse(() => <SkeletonList label={m.pr_links_loading()} rows={2} rowClassName="h-4" />)
  }

  const linked = new Set(links.map((link) => link.url))
  const urls = [...linked]
  if (branchPullRequest && !linked.has(branchPullRequest.url)) urls.push(branchPullRequest.url)
  const selected = picked && urls.includes(picked) ? picked : (branchPullRequest?.url ?? urls.at(-1))

  return (
    <div className="flex flex-col gap-4">
      {urls.length === 0 && <p className="text-xs text-muted-foreground">{m.pr_links_empty()}</p>}
      {urls.length > 1 && (
        <ul aria-label={m.pr_links_title()} className="flex flex-col gap-0.5">
          {urls.map((url) => (
            <PullRequestRow key={url} url={url} selected={url === selected} onSelect={() => setPicked(url)} />
          ))}
        </ul>
      )}
      {selected && (
        <PullRequestDetailView
          key={selected}
          threadId={threadId}
          url={selected}
          linked={linked.has(selected)}
          onUnlinkFailed={setUnlinkError}
        />
      )}
      {unlinkError && (
        <p role="alert" className="text-xs text-destructive">
          {unlinkError}
        </p>
      )}
      {live && worktree.status === "ready" && <CreatePullRequestButton threadId={threadId} worktreeId={worktree.id} />}
      <GitHubAuthHint />
    </div>
  )
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

function PullRequestRow({ url, selected, onSelect }: { url: string; selected: boolean; onSelect: () => void }) {
  const status = useAtomValue(pullRequestStatusAtom(url))
  const pullRequest = AsyncResult.isSuccess(status) ? status.value : undefined

  return (
    <li>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={onSelect}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-muted"
      >
        <RiGitPullRequestLine
          aria-hidden
          className={cn("size-3.5 shrink-0", pullRequest ? statusColor[pullRequest.status] : "text-muted-foreground")}
        />
        <span className="shrink-0 font-mono text-muted-foreground">#{pullRequest?.number ?? shortName(url)}</span>
        <span className="min-w-0 flex-1 truncate" title={pullRequest?.title}>
          {pullRequest ? pullRequestSummary(pullRequest) : null}
        </span>
        {pullRequest?.checks && <ChecksIndicator checks={pullRequest.checks} />}
      </button>
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

interface PullRequestDetailViewProps {
  readonly threadId: string
  readonly url: string
  readonly linked: boolean
  readonly onUnlinkFailed: (message: string | null) => void
}

function PullRequestDetailView({ threadId, url, linked, onUnlinkFailed }: PullRequestDetailViewProps) {
  const detailAtom = pullRequestDetailAtom(url)
  const detail = useAtomValue(detailAtom)
  const refresh = useAtomRefresh(detailAtom)
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom), () => null)?.type === "signedIn"

  return AsyncResult.builder(detail)
    .onSuccess((pullRequest) => (
      <article aria-label={pullRequest.title} className="flex flex-col gap-4">
        <PullRequestHeader
          pullRequest={pullRequest}
          threadId={threadId}
          linked={linked}
          onUnlinkFailed={onUnlinkFailed}
        />
        <Attention pullRequest={pullRequest} threadId={threadId} />
        {isOpen(pullRequest.status) && <PullRequestActions pullRequest={pullRequest} onDone={refresh} />}
        <ChecksSection pullRequest={pullRequest} />
        <Section title={m.pr_description()}>
          {pullRequest.body.trim() === "" ? (
            <p className="text-xs text-muted-foreground">{m.pr_description_empty()}</p>
          ) : (
            <div className="text-sm">
              <Markdown text={pullRequest.body} />
            </div>
          )}
        </Section>
      </article>
    ))
    .onError((error) => (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs">
          <PullRequestLink url={url} className="min-w-0 flex-1" />
          {linked && <UnlinkButton threadId={threadId} url={url} onUnlinkFailed={onUnlinkFailed} />}
        </div>
        {/* Without a gh login every lookup fails the same way; the auth hint below explains it once. */}
        {signedIn && (
          <div role="alert" className="flex items-center gap-2">
            <p className="text-xs text-destructive">{m.pr_detail_failed({ message: errorMessage(error) })}</p>
            <Button variant="outline" size="xs" onClick={refresh}>
              {m.common_retry()}
            </Button>
          </div>
        )}
      </div>
    ))
    .orElse(() => <SkeletonList label={m.pr_detail_loading()} rows={3} rowClassName="h-4" />)
}

function PullRequestHeader({
  pullRequest,
  threadId,
  linked,
  onUnlinkFailed,
}: {
  pullRequest: PullRequestDetail
  threadId: string
  linked: boolean
  onUnlinkFailed: (message: string | null) => void
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium text-pretty">{pullRequest.title}</h3>
        {linked && <UnlinkButton threadId={threadId} url={pullRequest.url} onUnlinkFailed={onUnlinkFailed} />}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className={cn("flex items-center gap-1 font-medium", statusColor[pullRequest.status])}>
          <RiGitPullRequestLine aria-hidden className="size-3.5" />
          {pullRequestStatusLabel[pullRequest.status]()}
        </span>
        {pullRequest.review && <span>{reviewLabel[pullRequest.review]()}</span>}
        <PullRequestLink url={pullRequest.url} className="hover:text-foreground" />
      </div>
      <p
        className="truncate font-mono text-xs text-muted-foreground"
        title={`${pullRequest.headRef} → ${pullRequest.baseRef}`}
      >
        {m.pr_branches({ head: pullRequest.headRef, base: pullRequest.baseRef })}
      </p>
    </header>
  )
}

function PullRequestLink({ url, className }: { url: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      className={cn(
        "flex items-center gap-1 rounded-sm font-mono underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="truncate">{shortName(url)}</span>
      <RiExternalLinkLine aria-hidden className="size-3 shrink-0" />
    </a>
  )
}

interface UnlinkButtonProps {
  readonly threadId: string
  readonly url: string
  readonly onUnlinkFailed: (message: string | null) => void
}

function UnlinkButton({ threadId, url, onUnlinkFailed }: UnlinkButtonProps) {
  const [pending, startTransition] = useTransition()
  const label = m.pr_links_unlink({ name: shortName(url) })

  // The pull request disappears when main pushes the updated list, so success needs no handling here.
  const unlink = () =>
    startTransition(async () => {
      try {
        await callPromise("pullRequests.unlink", { threadId, url })
        onUnlinkFailed(null)
      } catch (cause) {
        onUnlinkFailed(errorMessage(cause))
      }
    })

  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} title={label} disabled={pending} onClick={unlink}>
      <RiLinkUnlinkM aria-hidden />
    </Button>
  )
}

/** Only what needs a human gets a callout, each with the one action that hands it to the agent. */
function Attention({ pullRequest, threadId }: { pullRequest: PullRequestDetail; threadId: string }) {
  if (!isOpen(pullRequest.status)) return null
  const failing = pullRequest.checkRuns.filter((run) => run.status === "failing")
  const conflicting = pullRequest.mergeable === "conflicting"
  if (failing.length === 0 && !conflicting) return null

  return (
    <div className="flex flex-col gap-2">
      {conflicting && (
        <Callout tone="warning" message={m.pr_conflicts({ base: pullRequest.baseRef })}>
          <AskAgentButton
            threadId={threadId}
            prompt={resolveConflictsPrompt(pullRequest)}
            label={m.pr_resolve_conflicts()}
          />
        </Callout>
      )}
      {failing.length > 0 && (
        <Callout tone="danger" message={m.pr_checks_failing_count({ count: failing.length })}>
          <AskAgentButton threadId={threadId} prompt={fixChecksPrompt(pullRequest)} label={m.pr_fix_checks()} />
        </Callout>
      )}
    </div>
  )
}

const calloutTone = {
  warning: "border-amber-500/30 bg-amber-500/10",
  danger: "border-destructive/30 bg-destructive/10",
} as const

function Callout({
  tone,
  message,
  children,
}: {
  tone: keyof typeof calloutTone
  message: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex flex-col items-start gap-2 rounded-md border p-2.5", calloutTone[tone])}>
      <p className="text-xs">{message}</p>
      {children}
    </div>
  )
}

/** Sends the prompt into the thread: steers the running turn, or starts one. The reply shows in the thread. */
function AskAgentButton({ threadId, prompt, label }: { threadId: string; prompt: string; label: string }) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<{ type: "idle" } | { type: "sent" } | { type: "failed"; message: string }>({
    type: "idle",
  })

  const send = () =>
    startTransition(async () => {
      try {
        await callPromise("threads.steer", { threadId, text: prompt })
        setState({ type: "sent" })
      } catch (cause) {
        setState({ type: "failed", message: errorMessage(cause) })
      }
    })

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="xs" disabled={pending} onClick={send}>
        {label}
      </Button>
      {state.type === "sent" && <output className="text-xs text-muted-foreground">{m.pr_sent_to_agent()}</output>}
      {state.type === "failed" && (
        <p role="alert" className="text-xs text-destructive">
          {state.message}
        </p>
      )}
    </div>
  )
}

const fixChecksPrompt = (pullRequest: PullRequestDetail) => {
  const failing = pullRequest.checkRuns
    .filter((run) => run.status === "failing")
    .map((run) => `- ${run.name}${run.url ? `: ${run.url}` : ""}`)
  return [
    `CI is failing on ${pullRequest.url} (branch ${pullRequest.headRef}). Failing checks:`,
    ...failing,
    "",
    "Read the failing logs (for GitHub Actions, `gh run view <run-id> --log-failed`), find the root cause, fix it, verify locally, and push.",
  ].join("\n")
}

const resolveConflictsPrompt = (pullRequest: PullRequestDetail) =>
  [
    `${pullRequest.url} has merge conflicts with ${pullRequest.baseRef}.`,
    `Fetch origin, merge origin/${pullRequest.baseRef} into ${pullRequest.headRef}, and resolve the conflicts so both sides keep their intent.`,
    "Run the project's checks, then push.",
  ].join(" ")

type PendingAction = { type: "merge"; method: MergeMethod } | { type: "close" }

function PullRequestActions({ pullRequest, onDone }: { pullRequest: PullRequestDetail; onDone: () => void }) {
  const [method, setMethod] = useState<MergeMethod>("squash")
  const [confirming, setConfirming] = useState<PendingAction | null>(null)
  const refreshStatus = useAtomRefresh(pullRequestStatusAtom(pullRequest.url))
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom), () => null)?.type === "signedIn"
  const blocker =
    pullRequest.status === "draft"
      ? m.pr_merge_blocked_draft()
      : pullRequest.mergeable === "conflicting"
        ? m.pr_merge_blocked_conflicts()
        : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div data-slot="button-group" className="flex">
          <Button
            size="sm"
            className="rounded-r-none"
            disabled={!signedIn || blocker !== null}
            onClick={() => setConfirming({ type: "merge", method })}
          >
            {mergeLabel[method]()}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  className="rounded-l-none border-l border-primary-foreground/20"
                  aria-label={m.pr_merge_method()}
                  title={m.pr_merge_method()}
                  disabled={!signedIn || blocker !== null}
                />
              }
            >
              <RiArrowDownSLine aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuRadioGroup value={method} onValueChange={(value: MergeMethod) => setMethod(value)}>
                {(["squash", "merge", "rebase"] as const).map((option) => (
                  <DropdownMenuRadioItem key={option} value={option} closeOnClick>
                    {mergeLabel[option]()}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button variant="ghost" size="sm" disabled={!signedIn} onClick={() => setConfirming({ type: "close" })}>
          {m.pr_close()}
        </Button>
      </div>
      {blocker && <p className="text-xs text-muted-foreground">{blocker}</p>}
      <ConfirmDialog
        pullRequest={pullRequest}
        action={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onDone={() => {
          onDone()
          refreshStatus()
        }}
      />
    </div>
  )
}

function ConfirmDialog({
  pullRequest,
  action,
  onOpenChange,
  onDone,
}: {
  pullRequest: PullRequestDetail
  action: PendingAction | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const number = pullRequest.number
  // The dialog keeps showing its last action while it animates closed, after `action` is already null.
  const [shown, setShown] = useState(action)
  if (action !== null && action !== shown) setShown(action)

  const confirm = () =>
    startTransition(async () => {
      if (!shown) return
      setError(null)
      try {
        if (shown.type === "merge") await callPromise("github.merge", { url: pullRequest.url, method: shown.method })
        else await callPromise("github.close", { url: pullRequest.url })
        onOpenChange(false)
        onDone()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) setError(null)
        onOpenChange(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {shown?.type === "close"
              ? m.pr_close_title({ number })
              : m.pr_merge_title({ number, method: shown ? mergeLabel[shown.method]() : "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {shown?.type === "close"
              ? m.pr_close_body()
              : m.pr_merge_body({ head: pullRequest.headRef, base: pullRequest.baseRef })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant={shown?.type === "close" ? "destructive" : "default"}
            disabled={pending}
            onClick={confirm}
          >
            {shown?.type === "close" ? m.pr_close() : shown ? mergeLabel[shown.method]() : null}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ChecksSection({ pullRequest }: { pullRequest: PullRequestDetail }) {
  const ran = pullRequest.checkRuns.filter((run) => run.status !== "skipped")
  const skipped = pullRequest.checkRuns.length - ran.length
  if (pullRequest.checkRuns.length === 0) return null

  return (
    <Section title={m.pr_checks()}>
      <ul className="flex flex-col gap-0.5">
        {ran.map((run, index) => {
          const { Icon, className, label } = checkRunIndicator[run.status]
          return (
            <li key={`${index}:${run.name}`} className="flex min-w-0 items-center gap-2 text-xs">
              <Icon aria-label={label()} className={cn("size-3.5 shrink-0", className)} />
              {run.url ? (
                <a
                  href={run.url}
                  target="_blank"
                  rel="noreferrer"
                  title={run.name}
                  className="min-w-0 truncate rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {run.name}
                </a>
              ) : (
                <span className="min-w-0 truncate" title={run.name}>
                  {run.name}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {skipped > 0 && <p className="text-xs text-muted-foreground">{m.pr_checks_skipped_count({ count: skipped })}</p>}
    </Section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="text-xs font-medium text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  )
}
