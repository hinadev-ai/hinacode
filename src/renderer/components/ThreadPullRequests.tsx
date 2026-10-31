import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useId, useState, useTransition } from "react"
import type {
  CheckRunStatus,
  ChecksStatus,
  MergeMethod,
  PullRequest,
  PullRequestDetail,
  PullRequestStatus,
  PullRequestWatch,
  ReviewStatus,
  Thread,
} from "../../shared/domain.ts"
import { fixChecksPrompt, resolveConflictsPrompt } from "../../shared/pullRequestPrompts.ts"
import { checksIndicator as sharedChecksIndicator, isOpen, pullRequestIndicator } from "../../shared/threadStatus.ts"
import { toIcon } from "../lib/indicators.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import {
  branchPullRequestAtom,
  callPromise,
  gitHubAuthAtom,
  pullRequestDetailAtom,
  pullRequestStatusAtom,
} from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { useOpenThreadEnvironment, usePullRequestHref } from "../lib/environments.ts"
import { m } from "../paraglide/messages.js"
import { loadPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { type PullRequestSection, useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { Markdown } from "./Markdown.tsx"
import { PullRequestCode } from "./PullRequestCode.tsx"
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"
import { ChevronDownIcon } from "./icons/ChevronDownIcon.tsx"
import { ChevronRightIcon } from "./icons/ChevronRightIcon.tsx"
import { ExternalIcon } from "./icons/ExternalIcon.tsx"
import { EyeFillIcon } from "./icons/EyeFillIcon.tsx"
import { EyeIcon } from "./icons/EyeIcon.tsx"
import type { IconComponent } from "./icons/Icon.tsx"
import { MinusCircleIcon } from "./icons/MinusCircleIcon.tsx"
import { PullRequestIcon } from "./icons/PullRequestIcon.tsx"
import { UnlinkIcon } from "./icons/UnlinkIcon.tsx"

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

export const statusIndicator = {
  draft: toIcon(pullRequestIndicator.draft),
  open: toIcon(pullRequestIndicator.open),
  merged: toIcon(pullRequestIndicator.merged),
  closed: toIcon(pullRequestIndicator.closed),
} satisfies Record<PullRequestStatus, { Icon: IconComponent; className: string }>

export const reviewLabel = {
  approved: m.pr_review_approved,
  changesRequested: m.pr_review_changes_requested,
  reviewRequired: m.pr_review_required,
} satisfies Record<ReviewStatus, () => string>

export const checksIndicator = {
  passing: { ...toIcon(sharedChecksIndicator.passing), label: m.pr_checks_passing },
  failing: { ...toIcon(sharedChecksIndicator.failing), label: m.pr_checks_failing },
  pending: { ...toIcon(sharedChecksIndicator.pending), label: m.pr_checks_pending },
} satisfies Record<ChecksStatus, { Icon: IconComponent; className: string; label: () => string }>

const checkRunIndicator = {
  ...checksIndicator,
  skipped: { Icon: MinusCircleIcon, className: "text-muted-foreground", label: m.pr_check_skipped },
} satisfies Record<CheckRunStatus, { Icon: IconComponent; className: string; label: () => string }>

export const mergeLabel = {
  squash: m.pr_merge_squash,
  merge: m.pr_merge_commit,
  rebase: m.pr_merge_rebase,
} satisfies Record<MergeMethod, () => string>

/** The pull request's state as GitHub draws it. Before the state loads, a plain muted pull request icon. */
export function StatusIcon({
  status,
  colored = false,
  className,
}: {
  status: PullRequestStatus | undefined
  colored?: boolean
  className?: string
}) {
  const indicator = status && statusIndicator[status]
  const Icon = indicator?.Icon ?? PullRequestIcon
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", colored && (indicator?.className ?? "text-muted-foreground"), className)}
    />
  )
}

type PullRequestTab = "info" | "code"

/**
 * The PR tab. Every pull request the thread has: the ones agents linked plus the one GitHub has for the
 * worktree branch. Several show as a list to pick from; the picked one shows below, as its info or its code.
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
  const [tab, setTab] = useState<PullRequestTab>("info")
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

  if (!links) {
    return AsyncResult.builder(load)
      .onError((error) => (
        <div role="alert" className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs wrap-anywhere text-destructive">
            {m.pr_links_failed({ message: errorMessage(error) })}
          </p>
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
  const watch = links.find((link) => link.url === selected)?.watch ?? null

  return (
    <div className="flex flex-col gap-4">
      {urls.length === 0 && <p className="text-xs text-muted-foreground">{m.pr_links_empty()}</p>}
      {urls.length > 1 && (
        <Section
          id="links"
          title={m.pr_links_title()}
          collapsedSummary={<span className="font-normal tabular-nums">{urls.length}</span>}
        >
          <ul className="flex flex-col gap-0.5">
            {urls.map((url) => (
              <PullRequestRow
                key={url}
                url={url}
                selected={url === selected}
                watching={links.some((link) => link.url === url && link.watch !== null)}
                onSelect={() => setPicked(url)}
              />
            ))}
          </ul>
        </Section>
      )}
      {selected && (
        <SelectedPullRequest
          key={selected}
          threadId={threadId}
          url={selected}
          watch={watch}
          linked={linked.has(selected)}
          tab={tab}
          onTabChange={setTab}
          onUnlinkFailed={setUnlinkError}
        />
      )}
      {unlinkError && (
        <p role="alert" className="text-xs text-destructive">
          {unlinkError}
        </p>
      )}
      <GitHubAuthHint />
    </div>
  )
}

interface SelectedPullRequestProps extends PullRequestDetailViewProps {
  readonly tab: PullRequestTab
  readonly onTabChange: (tab: PullRequestTab) => void
}

function SelectedPullRequest({ tab, onTabChange, ...detail }: SelectedPullRequestProps) {
  return (
    <div className="flex flex-col gap-4">
      <Tabs value={tab} onValueChange={(value: PullRequestTab) => onTabChange(value)}>
        <TabsList variant="line" aria-label={m.pr_view_label()}>
          <TabsTrigger value="info">{m.pr_tab_info()}</TabsTrigger>
          <TabsTrigger value="code">{m.pr_tab_code()}</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "info" ? <PullRequestDetailView {...detail} /> : <PullRequestCode url={detail.url} />}
    </div>
  )
}

function GitHubAuthHint() {
  const environment = useOpenThreadEnvironment()
  const auth = useAtomValue(gitHubAuthAtom(environment))
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

function PullRequestRow({
  url,
  selected,
  watching,
  onSelect,
}: {
  url: string
  selected: boolean
  watching: boolean
  onSelect: () => void
}) {
  const environment = useOpenThreadEnvironment()
  const status = useAtomValue(pullRequestStatusAtom(environment, url))
  const pullRequest = AsyncResult.isSuccess(status) ? status.value : undefined

  return (
    <li>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={onSelect}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-muted"
      >
        <StatusIcon status={pullRequest?.status} colored />
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={pullRequest ? undefined : url}>
          #{pullRequest?.number ?? shortName(url)}
        </span>
        <span className="min-w-0 flex-1 truncate" title={pullRequest?.title}>
          {pullRequest ? pullRequestSummary(pullRequest) : null}
        </span>
        {watching && (
          <span title={m.pr_watching()} className="flex shrink-0">
            <EyeIcon aria-hidden className="size-3.5 text-muted-foreground" />
            <span className="sr-only">{m.pr_watching()}</span>
          </span>
        )}
        {pullRequest?.checks && <ChecksIndicator checks={pullRequest.checks} />}
      </button>
    </li>
  )
}

// Status leads so a long title truncates instead of hiding it.
const pullRequestSummary = ({ title, status, review }: PullRequest) =>
  [pullRequestStatusLabel[status](), review && reviewLabel[review](), title].filter(Boolean).join(" · ")

export function ChecksIndicator({ checks, className }: { checks: ChecksStatus; className?: string }) {
  const { Icon, className: color, label } = checksIndicator[checks]
  return (
    <span title={label()} className="flex shrink-0">
      <Icon aria-hidden className={cn("size-3.5", color, className)} />
      <span className="sr-only">{label()}</span>
    </span>
  )
}

interface PullRequestDetailViewProps {
  readonly threadId: string
  readonly url: string
  readonly watch: PullRequestWatch | null
  readonly linked: boolean
  readonly onUnlinkFailed: (message: string | null) => void
}

function PullRequestDetailView({ threadId, url, watch, linked, onUnlinkFailed }: PullRequestDetailViewProps) {
  const environment = useOpenThreadEnvironment()
  const detailAtom = pullRequestDetailAtom(environment, url)
  const detail = useAtomValue(detailAtom)
  const refresh = useAtomRefresh(detailAtom)
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom(environment)), () => null)?.type === "signedIn"

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
        {isOpen(pullRequest.status) && (
          <PullRequestActions pullRequest={pullRequest} threadId={threadId} watch={watch} onDone={refresh} />
        )}
        <ChecksSection pullRequest={pullRequest} />
        <Section id="description" title={m.pr_description()}>
          {pullRequest.body.trim() === "" ? (
            <p className="text-xs text-muted-foreground">{m.pr_description_empty()}</p>
          ) : (
            <Markdown text={pullRequest.body} />
          )}
        </Section>
      </article>
    ))
    .onError((error) => (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs">
          <PullRequestLink threadId={threadId} url={url} className="min-w-0 flex-1" />
          {linked && <UnlinkButton threadId={threadId} url={url} onUnlinkFailed={onUnlinkFailed} />}
        </div>
        {/* Without a gh login every lookup fails the same way; the auth hint below explains it once. */}
        {signedIn && (
          <div role="alert" className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-xs wrap-anywhere text-destructive">
              {m.pr_detail_failed({ message: errorMessage(error) })}
            </p>
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
        <span className={cn("flex items-center gap-1 font-medium", statusIndicator[pullRequest.status].className)}>
          <StatusIcon status={pullRequest.status} />
          {pullRequestStatusLabel[pullRequest.status]()}
        </span>
        {pullRequest.review && <span>{reviewLabel[pullRequest.review]()}</span>}
        <PullRequestLink threadId={threadId} url={pullRequest.url} className="hover:text-foreground" />
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

function PullRequestLink({ threadId, url, className }: { threadId: string; url: string; className?: string }) {
  const href = usePullRequestHref(threadId, url)
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      className={cn(
        "flex items-center gap-1 rounded-sm font-mono underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="truncate">{shortName(url)}</span>
      <ExternalIcon aria-hidden className="size-3 shrink-0" />
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
      <UnlinkIcon aria-hidden />
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
  warning: "border-attention/30 bg-attention/10",
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

type PendingAction = { type: "merge"; method: MergeMethod } | { type: "close" }

function PullRequestActions({
  pullRequest,
  threadId,
  watch,
  onDone,
}: {
  pullRequest: PullRequestDetail
  threadId: string
  watch: PullRequestWatch | null
  onDone: () => void
}) {
  const environment = useOpenThreadEnvironment()
  const [method, setMethod] = useState<MergeMethod>("squash")
  const [confirming, setConfirming] = useState<PendingAction | null>(null)
  const refreshStatus = useAtomRefresh(pullRequestStatusAtom(environment, pullRequest.url))
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom(environment)), () => null)?.type === "signedIn"
  const blocker =
    pullRequest.status === "draft"
      ? m.pr_merge_blocked_draft()
      : pullRequest.mergeable === "conflicting"
        ? m.pr_merge_blocked_conflicts()
        : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
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
              <ChevronDownIcon aria-hidden />
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
        <WatchButton threadId={threadId} url={pullRequest.url} watch={watch} />
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

function WatchButton({ threadId, url, watch }: { threadId: string; url: string; watch: PullRequestWatch | null }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const watching = watch !== null

  const toggle = () =>
    startTransition(async () => {
      setError(null)
      try {
        if (watching) await callPromise("pullRequests.unwatch", { threadId, url })
        else await callPromise("pullRequests.watch", { threadId, url })
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <>
      <Button
        variant={watching ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={watching}
        title={watching ? m.pr_watch_stop({ name: shortName(url) }) : m.pr_watch_hint()}
        disabled={pending}
        onClick={toggle}
      >
        {watching ? <EyeFillIcon aria-hidden /> : <EyeIcon aria-hidden />}
        {watching ? m.pr_watching() : m.pr_watch()}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {m.pr_watch_failed({ message: error })}
        </p>
      )}
    </>
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
  const environment = useOpenThreadEnvironment()
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
        if (shown.type === "merge")
          await callPromise("github.merge", { url: pullRequest.url, method: shown.method }, { environment })
        else await callPromise("github.close", { url: pullRequest.url }, { environment })
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
    <Section
      id="checks"
      title={m.pr_checks()}
      collapsedSummary={pullRequest.checks && <ChecksIndicator checks={pullRequest.checks} />}
    >
      <ul className="flex flex-col gap-0.5">
        {ran.map((run, index) => {
          const { Icon, className, label } = checkRunIndicator[run.status]
          return (
            <li
              key={`${index}:${run.name}`}
              className={cn(
                "flex min-w-0 items-center gap-2 text-xs",
                run.status === "failing" ? "text-foreground" : "text-muted-foreground",
              )}
            >
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

interface SectionProps {
  readonly id: PullRequestSection
  readonly title: string
  /** Shown next to the title while the section is collapsed. */
  readonly collapsedSummary?: ReactNode
  readonly children: ReactNode
}

function Section({ id, title, collapsedSummary, children }: SectionProps) {
  const headingId = useId()
  const open = useUi((state) => !state.collapsedPullRequestSections.includes(id))
  const setOpen = useUi((state) => state.setPullRequestSectionOpen)
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setOpen(id, next)}
      render={<section aria-labelledby={headingId} />}
      className="flex flex-col gap-2"
    >
      <h4 className="text-xs font-medium text-muted-foreground">
        <CollapsibleTrigger className="group/trigger -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
          />
          <span id={headingId}>{title}</span>
          {!open && collapsedSummary}
        </CollapsibleTrigger>
      </h4>
      <CollapsibleContent className="flex flex-col gap-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
