import { RiGitClosePullRequestLine, RiGitPullRequestLine } from "react-icons/ri"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { createContext, lazy, type ReactNode, Suspense, use, useId, useState, useTransition } from "react"
import type {
  CheckRunStatus,
  ChecksStatus,
  MergeMethod,
  PullRequestComment,
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
import { pullRequestName } from "../lib/pullRequestRefs.ts"
import { formatRelativeTime } from "../lib/relativeTime.ts"
import { useNow } from "../lib/useNow.ts"
import {
  branchPullRequestAtom,
  callPromise,
  gitHubAuthAtom,
  pullRequestDetailAtom,
  pullRequestStatusAtom,
  pullRequestStatusesAtom,
} from "../lib/rpc.ts"
import { pullRequestStacks, type StackNode } from "../lib/pullRequestStack.ts"
import { cn } from "../lib/utils.ts"
import { useOpenThreadEnvironment, usePullRequestHref } from "../lib/environments.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { loadPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { type PullRequestSection, type PullRequestTab, useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { externalImageUrl } from "../../shared/channels.ts"
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
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"
import { ChevronDownIcon } from "./icons/ChevronDownIcon.tsx"
import { ChevronRightIcon } from "./icons/ChevronRightIcon.tsx"
import { ExternalIcon } from "./icons/ExternalIcon.tsx"
import { FileDiffIcon } from "./icons/FileDiffIcon.tsx"
import { EyeFillIcon } from "./icons/EyeFillIcon.tsx"
import { EyeIcon } from "./icons/EyeIcon.tsx"
import type { IconComponent } from "./icons/Icon.tsx"
import { MinusCircleIcon } from "./icons/MinusCircleIcon.tsx"
import { MoreIcon } from "./icons/MoreIcon.tsx"
import { UnlinkIcon } from "./icons/UnlinkIcon.tsx"
import { Textarea } from "./ui/textarea.tsx"

const PullRequestCode = lazy(() =>
  import("./PullRequestCode.tsx").then((module) => ({ default: module.PullRequestCode })),
)

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
  const Icon = indicator?.Icon ?? RiGitPullRequestLine
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", colored && (indicator?.className ?? "text-muted-foreground"), className)}
    />
  )
}

const useThreadPullRequestUrls = (thread: Thread) => {
  const links = usePullRequests((state) => state.byThreadId[thread.id])
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const live = worktree !== undefined && worktree.status !== "removed"
  const branchPullRequest = AsyncResult.getOrElse(
    useAtomValue(branchPullRequestAtom(live ? worktree.id : null)),
    () => null,
  )
  const urls = [...new Set(links?.map((link) => link.url))]
  if (branchPullRequest && !urls.includes(branchPullRequest.url)) urls.push(branchPullRequest.url)
  return { links, urls, branchPullRequest }
}

export const useLinkedPullRequestsLabel = (threadId: string) => {
  const count = usePullRequests((state) => state.byThreadId[threadId]?.length ?? 0)
  return count === 0 ? null : m.sidebar_pull_request_stack({ count })
}

export function PullRequestsHeader({ thread }: { thread: Thread }) {
  const { urls } = useThreadPullRequestUrls(thread)
  const open = useUi((state) => state.linkedPullRequestsOpen)
  const setOpen = useUi((state) => state.setLinkedPullRequestsOpen)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 ps-2">
      <h2 className="truncate text-sm font-medium">{m.pr_links_title()}</h2>
      {urls.length > 0 && (
        <Button
          variant={open ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={open}
          className="ms-auto"
          action={() => setOpen(!open)}
        >
          {m.pr_tab_linked()}
          <span className="text-muted-foreground tabular-nums">{urls.length}</span>
        </Button>
      )}
    </div>
  )
}

export function ThreadPullRequests({ thread }: { thread: Thread }) {
  const threadId = thread.id
  const loadAtom = loadPullRequestsAtom(threadId)
  const load = useAtomValue(loadAtom)
  const reload = useAtomRefresh(loadAtom)
  const { links, urls, branchPullRequest } = useThreadPullRequestUrls(thread)
  const picked = useUi((state) => state.pickedPullRequests[threadId])
  const listOpen = useUi((state) => state.linkedPullRequestsOpen)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

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
  const selected = picked !== undefined && urls.includes(picked) ? picked : (branchPullRequest?.url ?? urls.at(-1))
  const watched = new Set(links.filter((link) => link.watch !== null).map((link) => link.url))

  if (selected === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">{m.pr_links_empty()}</p>
        <GitHubAuthHint />
      </div>
    )
  }

  const select = (url: string) =>
    startTransition(() => {
      useUi.getState().pickPullRequest(threadId, url)
      useUi.getState().setLinkedPullRequestsOpen(false)
    })

  return (
    <div className="flex flex-col gap-4">
      {listOpen ? (
        <LinkedPullRequests urls={urls} selected={selected} watched={watched} onSelect={select} />
      ) : (
        <PullRequestDetailView
          key={selected}
          threadId={threadId}
          url={selected}
          watch={links.find((link) => link.url === selected)?.watch ?? null}
          linked={linked.has(selected)}
          onUnlinkFailed={(message) => startTransition(() => setUnlinkError(message))}
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

interface LinkedList {
  readonly selected: string
  readonly watched: ReadonlySet<string>
  readonly order: ReadonlyMap<string, number>
  readonly onSelect: (url: string) => void
}

const LinkedListContext = createContext<LinkedList | null>(null)

const flatten = (stacks: ReadonlyArray<StackNode>): ReadonlyArray<string> =>
  stacks.flatMap((stack) => [stack.url, ...flatten(stack.children)])

const repositoryName = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? url

const ENTRANCE_STAGGER_MS = 25

function LinkedPullRequests({
  urls,
  selected,
  watched,
  onSelect,
}: {
  urls: ReadonlyArray<string>
  selected: string
  watched: ReadonlySet<string>
  onSelect: (url: string) => void
}) {
  const environment = useOpenThreadEnvironment()
  const branches = useAtomValue(pullRequestStatusesAtom(environment, urls))
  const stacks = pullRequestStacks(urls, branches)
  const list: LinkedList = {
    selected,
    watched,
    order: new Map(flatten(stacks).map((url, index) => [url, index])),
    onSelect,
  }
  return (
    <LinkedListContext value={list}>
      <PullRequestTree stacks={stacks} />
    </LinkedListContext>
  )
}

function PullRequestTree({ stacks, nested = false }: { stacks: ReadonlyArray<StackNode>; nested?: boolean }) {
  return (
    <ul className={cn("flex flex-col gap-0.5", nested && "ms-4 border-s ps-2")}>
      {stacks.map((stack) => (
        <LinkedPullRequestRow key={stack.url} url={stack.url}>
          {stack.children.length > 0 && <PullRequestTree stacks={stack.children} nested />}
        </LinkedPullRequestRow>
      ))}
    </ul>
  )
}

function LinkedPullRequestRow({ url, children }: { url: string; children: ReactNode }) {
  const list = use(LinkedListContext)
  const environment = useOpenThreadEnvironment()
  const status = useAtomValue(pullRequestStatusAtom(environment, url))
  if (list === null) return null
  const pullRequest = AsyncResult.isSuccess(status) ? status.value : undefined
  const selected = list.selected === url

  return (
    <li
      className="animate-fade-in [animation-fill-mode:backwards] motion-reduce:animate-none"
      style={{ animationDelay: `${(list.order.get(url) ?? 0) * ENTRANCE_STAGGER_MS}ms` }}
    >
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={() => list.onSelect(url)}
        className="relative isolate grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-lg px-2 py-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-muted"
      >
        <span className="row-span-2 flex pt-0.5">
          <ChangingStatusIcon status={pullRequest?.status} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-muted-foreground">#{pullRequest?.number ?? "…"}</span>
          <span className="min-w-0 truncate text-[0.8125rem] font-medium" title={pullRequest?.title}>
            {pullRequest?.title}
          </span>
          {pullRequest?.checks && <ChecksIndicator checks={pullRequest.checks} />}
          {list.watched.has(url) && (
            <span title={m.pr_watching()} className="flex shrink-0">
              <EyeIcon aria-hidden className="size-3.5 text-muted-foreground" />
              <span className="sr-only">{m.pr_watching()}</span>
            </span>
          )}
          {pullRequest && (
            <span className="ms-auto shrink-0 font-mono tabular-nums">
              <span className="text-success">+{pullRequest.additions}</span>{" "}
              <span className="text-destructive">−{pullRequest.deletions}</span>
            </span>
          )}
        </span>
        {pullRequest && (
          <span className="col-start-2 overflow-hidden">
            <span className="flex min-w-0 items-center gap-2.5 pt-1 text-muted-foreground">
              <span className="flex shrink-0 items-center gap-1.5">
                <Avatar login={pullRequest.author} />
                {pullRequest.author}
              </span>
              <span className="min-w-0 shrink-2 truncate font-mono" title={repositoryName(url)}>
                {repositoryName(url)}
              </span>
              <span
                className="min-w-0 truncate font-mono"
                title={`${pullRequest.baseRefName} ← ${pullRequest.headRefName}`}
              >
                {m.pr_branches_into({ base: pullRequest.baseRefName, head: pullRequest.headRefName })}
              </span>
            </span>
          </span>
        )}
      </button>
      {children}
    </li>
  )
}

function ChangingStatusIcon({ status }: { status: PullRequestStatus | undefined }) {
  return (
    <span className="relative flex size-4">
      <span key={status ?? "loading"} className="flex animate-fade-in motion-reduce:animate-none">
        <StatusIcon status={status} colored className="size-4" />
        <span className="sr-only">{status && pullRequestStatusLabel[status]()}</span>
      </span>
    </span>
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
  const guideEnabled = useSettings(environment).pullRequestGuide.enabled
  const chosenTab = useUi((state) => state.pullRequestTab)
  const tab = chosenTab === "guide" && !guideEnabled ? "info" : chosenTab
  const setTab = useUi((state) => state.setPullRequestTab)

  return AsyncResult.builder(detail)
    .onSuccess((pullRequest) => (
      <article aria-label={pullRequest.title} className="flex flex-col gap-4">
        <PullRequestHeader
          pullRequest={pullRequest}
          threadId={threadId}
          watch={watch}
          linked={linked}
          onUnlinkFailed={onUnlinkFailed}
        />
        <Tabs value={tab} changeAction={(value: PullRequestTab) => setTab(value)}>
          <TabsList variant="line" aria-label={m.pr_view_label()} className="-ms-2 group-data-horizontal/tabs:h-7">
            <TabsTrigger value="info" className="flex-none px-2 text-xs">
              {m.pr_tab_info()}
            </TabsTrigger>
            <TabsTrigger value="files" className="flex-none px-2 text-xs">
              {m.pr_tab_changes()}
            </TabsTrigger>
            {guideEnabled && (
              <TabsTrigger value="guide" className="flex-none px-2 text-xs">
                {m.pr_code_view_guide()}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        {tab === "info" ? (
          <>
            <Attention pullRequest={pullRequest} threadId={threadId} />
            <ChecksSection pullRequest={pullRequest} />
            <Section id="description" title={m.pr_description()}>
              {pullRequest.body.trim() === "" ? (
                <p className="text-xs text-muted-foreground">{m.pr_description_empty()}</p>
              ) : (
                <FoldedMarkdown text={pullRequest.body} className="prose-sm" foldedClassName="max-h-48" />
              )}
            </Section>
            <CommentsSection pullRequest={pullRequest} />
          </>
        ) : (
          <Suspense>
            <PullRequestCode url={pullRequest.url} view={tab} />
          </Suspense>
        )}
      </article>
    ))
    .orElse(() => (
      <PullRequestDetailFallback
        detail={detail}
        threadId={threadId}
        url={url}
        linked={linked}
        onUnlinkFailed={onUnlinkFailed}
      />
    ))
}

function PullRequestDetailFallback({
  detail,
  threadId,
  url,
  linked,
  onUnlinkFailed,
}: {
  detail: AsyncResult.AsyncResult<PullRequestDetail, unknown>
  threadId: string
  url: string
  linked: boolean
  onUnlinkFailed: (message: string | null) => void
}) {
  const environment = useOpenThreadEnvironment()
  const refresh = useAtomRefresh(pullRequestDetailAtom(environment, url))
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom(environment)), () => null)?.type === "signedIn"
  if (!AsyncResult.isFailure(detail)) {
    return <SkeletonList label={m.pr_detail_loading()} rows={3} rowClassName="h-4" />
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs">
        <PullRequestLink threadId={threadId} url={url} className="min-w-0 flex-1" />
        {linked && <UnlinkButton threadId={threadId} url={url} onUnlinkFailed={onUnlinkFailed} />}
      </div>
      {signedIn && (
        <div role="alert" className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs wrap-anywhere text-destructive">
            {m.pr_detail_failed({ message: errorMessage(Cause.squash(detail.cause)) })}
          </p>
          <Button variant="outline" size="xs" onClick={refresh}>
            {m.common_retry()}
          </Button>
        </div>
      )}
    </div>
  )
}

function PullRequestHeader({
  pullRequest,
  threadId,
  watch,
  linked,
  onUnlinkFailed,
}: {
  pullRequest: PullRequestDetail
  threadId: string
  watch: PullRequestWatch | null
  linked: boolean
  onUnlinkFailed: (message: string | null) => void
}) {
  const environment = useOpenThreadEnvironment()
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom(environment)), () => null)?.type === "signedIn"
  const [method, setMethod] = useState<MergeMethod>("squash")
  const [confirming, setConfirming] = useState<PendingAction | null>(null)
  const [, startTransition] = useTransition()
  const open = isOpen(pullRequest.status)
  const blocker =
    pullRequest.status === "draft"
      ? m.pr_merge_blocked_draft()
      : pullRequest.mergeable === "conflicting"
        ? m.pr_merge_blocked_conflicts()
        : null

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <PullRequestLink threadId={threadId} url={pullRequest.url} className="shrink-0 hover:text-foreground">
            #{pullRequest.number}
          </PullRequestLink>
          <span className="min-w-0 truncate font-mono" title={`${pullRequest.baseRef} ← ${pullRequest.headRef}`}>
            {m.pr_branches_into({ base: pullRequest.baseRef, head: pullRequest.headRef })}
          </span>
          <span
            className={cn(
              "ms-auto flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium capitalize",
              statusIndicator[pullRequest.status].className,
            )}
          >
            <StatusIcon status={pullRequest.status} />
            {pullRequestStatusLabel[pullRequest.status]()}
          </span>
          <MoreMenu
            threadId={threadId}
            url={pullRequest.url}
            linked={linked}
            onUnlinkFailed={onUnlinkFailed}
            onClose={open && signedIn ? () => startTransition(() => setConfirming({ type: "close" })) : null}
          />
        </div>
        <h3 className="text-base/snug font-semibold text-pretty">{pullRequest.title}</h3>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <Avatar login={pullRequest.author} />
          <span className="truncate font-medium">{pullRequest.author}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs whitespace-nowrap tabular-nums">
          <span
            className="flex items-center gap-1 text-muted-foreground"
            title={m.pr_code_summary({ count: pullRequest.changedFiles })}
          >
            <FileDiffIcon aria-hidden className="size-3.5" />
            {pullRequest.changedFiles}
            <span className="sr-only">{m.pr_code_summary({ count: pullRequest.changedFiles })}</span>
          </span>
          <span
            className="font-mono"
            title={m.pr_card_size({ additions: pullRequest.additions, deletions: pullRequest.deletions })}
          >
            <span className="text-success">+{pullRequest.additions}</span>{" "}
            <span className="text-destructive">−{pullRequest.deletions}</span>
          </span>
        </span>
        {open && (
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <MergeSplitButton
              method={method}
              onMethodChange={(next) => startTransition(() => setMethod(next))}
              disabled={!signedIn || blocker !== null}
              onMerge={() => startTransition(() => setConfirming({ type: "merge", method }))}
            />
            <WatchButton threadId={threadId} url={pullRequest.url} watch={watch} />
          </div>
        )}
      </div>
      {open && blocker && <p className="text-xs text-muted-foreground">{blocker}</p>}
      <ConfirmDialog
        pullRequest={pullRequest}
        action={confirming}
        onOpenChange={(next) => !next && setConfirming(null)}
      />
    </header>
  )
}

function Avatar({ login }: { login: string }) {
  const [failed, setFailed] = useState(false)
  const src = externalImageUrl(`https://github.com/${login}.png?size=48`)
  if (failed || src === null) {
    return (
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[0.5625rem] font-medium uppercase"
      >
        {login.slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 rounded-full bg-muted outline-1 -outline-offset-1 outline-white/10"
      onError={() => setFailed(true)}
    />
  )
}

function MoreMenu({
  threadId,
  url,
  linked,
  onUnlinkFailed,
  onClose,
}: {
  threadId: string
  url: string
  linked: boolean
  onUnlinkFailed: (message: string | null) => void
  onClose: (() => void) | null
}) {
  const href = usePullRequestHref(threadId, url)
  const [, startTransition] = useTransition()

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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={m.pr_more_actions()} title={m.pr_more_actions()} />}
      >
        <MoreIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          render={<a href={href} target="_blank" rel="noreferrer" aria-label={m.pr_open_on_github()} />}
        >
          <ExternalIcon aria-hidden />
          {m.pr_open_on_github()}
        </DropdownMenuItem>
        {linked && (
          <DropdownMenuItem onClick={unlink}>
            <UnlinkIcon aria-hidden />
            {m.pr_unlink()}
          </DropdownMenuItem>
        )}
        {onClose && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onClose}>
              <RiGitClosePullRequestLine aria-hidden />
              {m.pr_close()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PullRequestLink({
  threadId,
  url,
  className,
  children,
}: {
  threadId: string
  url: string
  className?: string
  children?: ReactNode
}) {
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
      <span className="truncate">{children ?? pullRequestName(url)}</span>
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
  const label = m.pr_links_unlink({ name: pullRequestName(url) })

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

const mergeSegment =
  "flex items-center outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed"

function MergeSplitButton({
  method,
  onMethodChange,
  disabled,
  onMerge,
}: {
  method: MergeMethod
  onMethodChange: (method: MergeMethod) => void
  disabled: boolean
  onMerge: () => void
}) {
  const MergeIcon = statusIndicator.merged.Icon
  return (
    <fieldset
      aria-label={mergeLabel[method]()}
      className="merge-pill m-0 flex h-7 min-w-0 rounded-full border-0 p-0 text-xs font-medium"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onMerge}
        className={cn(mergeSegment, "gap-1.5 rounded-s-full ps-2.5 pe-2")}
      >
        <MergeIcon aria-hidden className="size-3.5" />
        {mergeLabel[method]()}
      </button>
      <span aria-hidden className={cn("my-1.5 w-px", disabled ? "bg-border" : "bg-primary-foreground/25")} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={m.pr_merge_method()}
              title={m.pr_merge_method()}
              disabled={disabled}
              className={cn(mergeSegment, "rounded-e-full ps-1.5 pe-2")}
            />
          }
        >
          <ChevronDownIcon aria-hidden className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuRadioGroup value={method} onValueChange={(value: MergeMethod) => onMethodChange(value)}>
            {(["squash", "merge", "rebase"] as const).map((option) => (
              <DropdownMenuRadioItem key={option} value={option} closeOnClick>
                {mergeLabel[option]()}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </fieldset>
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
        size="icon-sm"
        aria-pressed={watching}
        aria-label={watching ? m.pr_watching() : m.pr_watch()}
        title={watching ? m.pr_watch_stop({ name: pullRequestName(url) }) : m.pr_watch_hint()}
        disabled={pending}
        onClick={toggle}
      >
        {watching ? <EyeFillIcon aria-hidden /> : <EyeIcon aria-hidden />}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-end text-xs text-destructive">
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
}: {
  pullRequest: PullRequestDetail
  action: PendingAction | null
  onOpenChange: (open: boolean) => void
}) {
  const environment = useOpenThreadEnvironment()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const number = pullRequest.number
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
  if (pullRequest.checkRuns.length === 0) return null

  return (
    <Section
      id="checks"
      title={m.pr_checks()}
      summary={pullRequest.checks && <ChecksIndicator checks={pullRequest.checks} />}
    >
      <CheckRunList pullRequest={pullRequest} />
    </Section>
  )
}

function CheckRunList({ pullRequest }: { pullRequest: PullRequestDetail }) {
  const ran = pullRequest.checkRuns.filter((run) => run.status !== "skipped")
  const skipped = pullRequest.checkRuns.length - ran.length
  return (
    <>
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
    </>
  )
}

function CommentsSection({ pullRequest }: { pullRequest: PullRequestDetail }) {
  const { comments } = pullRequest
  return (
    <Section
      id="comments"
      title={m.pr_comments()}
      summary={<span className="font-normal tabular-nums">{comments.length}</span>}
    >
      {comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">{m.pr_comments_empty()}</p>
      ) : (
        <ol className="flex flex-col gap-5">
          {comments.map((comment) => (
            <Comment key={comment.id} comment={comment} />
          ))}
        </ol>
      )}
      <CommentComposer url={pullRequest.url} />
    </Section>
  )
}

const LONG_TEXT = 600

function FoldedMarkdown({
  text,
  className,
  foldedClassName,
}: {
  text: string
  className: string
  foldedClassName: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [, startTransition] = useTransition()
  const long = text.length > LONG_TEXT
  return (
    <>
      <Markdown
        text={text}
        className={cn(className, long && !expanded && cn("overflow-hidden mask-b-from-50%", foldedClassName))}
      />
      {long && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-0"
          aria-expanded={expanded}
          onClick={() => startTransition(() => setExpanded(!expanded))}
        >
          {expanded ? m.pr_comment_less() : m.pr_comment_more()}
        </Button>
      )}
    </>
  )
}

export function Comment({ comment, showLocation = true }: { comment: PullRequestComment; showLocation?: boolean }) {
  const now = useNow()
  const locale = getLocale()
  const { location } = comment
  const where = showLocation && location && `${location.path}${location.line === null ? "" : `:${location.line}`}`

  return (
    <li
      className={cn(
        "flex flex-col gap-1.5",
        comment.authorKind === "bot" &&
          "opacity-70 transition-opacity duration-200 ease-out focus-within:opacity-100 hover:opacity-100",
      )}
    >
      <header className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium text-foreground">{comment.author}</span>
        {comment.authorKind === "bot" && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[0.625rem]">
            {m.pr_comment_bot()}
          </Badge>
        )}
        <a
          href={comment.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <time
            dateTime={comment.createdAt}
            title={new Date(comment.createdAt).toLocaleString(locale, { dateStyle: "long", timeStyle: "short" })}
          >
            {formatRelativeTime(comment.createdAt, now, locale)}
          </time>
        </a>
      </header>
      {where && (
        <p className="truncate font-mono text-xs text-muted-foreground" title={where}>
          {where}
        </p>
      )}
      <FoldedMarkdown text={comment.body} className="prose-sm text-xs" foldedClassName="max-h-32" />
    </li>
  )
}

function CommentComposer({ url }: { url: string }) {
  const environment = useOpenThreadEnvironment()
  const signedIn = AsyncResult.getOrElse(useAtomValue(gitHubAuthAtom(environment)), () => null)?.type === "signedIn"
  const [body, setBody] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const empty = body.trim() === ""

  const post = () =>
    startTransition(async () => {
      setError(null)
      try {
        await callPromise("github.comment", { url, body }, { environment })
        setBody("")
      } catch (cause) {
        setError(m.pr_comment_failed({ message: errorMessage(cause) }))
      }
    })

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !empty && !pending) post()
        }}
        placeholder={m.pr_comment_placeholder()}
        aria-label={m.pr_comment_placeholder()}
        disabled={!signedIn}
        className="max-h-48 text-xs"
      />
      <div className="flex items-center gap-2">
        {error && (
          <p role="alert" className="min-w-0 flex-1 text-xs wrap-anywhere text-destructive">
            {error}
          </p>
        )}
        <Button size="xs" className="ml-auto" disabled={!signedIn || empty || pending} onClick={post}>
          {m.pr_comment_submit()}
        </Button>
      </div>
    </div>
  )
}

interface SectionProps {
  readonly id: PullRequestSection
  readonly title: string
  readonly summary?: ReactNode
  readonly children: ReactNode
}

function Section({ id, title, summary, children }: SectionProps) {
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
          {summary}
        </CollapsibleTrigger>
      </h4>
      <CollapsibleContent className="flex flex-col gap-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
