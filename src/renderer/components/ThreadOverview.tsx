import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, type RefObject, startTransition, useRef, useState } from "react"
import { RiGitPullRequestLine, RiGithubFill, RiGitlabFill } from "react-icons/ri"
import { toast } from "sonner"
import { codeHostOfUrl, parseGitLabMergeRequestUrl, pullRequestNumberLabel } from "../../shared/codeHost.ts"
import type { ChecksStatus, Project, PullRequest, Thread, Worktree } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { useOpenSubagent } from "../lib/subagents.ts"
import { environmentName, useCloud, useClouds, usePullRequestHref, useThreadEnvironment } from "../lib/environments.ts"
import { useSettings } from "../lib/settings.ts"
import { branchPullRequestAtom, callPromise, projectsAtom, pullRequestStatusAtom } from "../lib/rpc.ts"
import { lineCounts } from "../lib/patch.ts"
import { useThreadChanges } from "../lib/threadChanges.ts"
import { cn } from "../lib/utils.ts"
import { parsePullRequestUrl, pullRequestName } from "../lib/pullRequestRefs.ts"
import { loadPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import { type TerminalCommand, useTerminals } from "../stores/terminals.ts"
import { type PullRequestTab, useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { ActionDialog, type ActionTarget } from "./ActionDialog.tsx"
import { CloudMark } from "./CloudMark.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { ProjectIcon } from "./ProjectIcon.tsx"
import { LineCounts } from "./LineCounts.tsx"
import {
  BranchIcon,
  ChatNewIcon,
  ChevronDownIcon,
  ComputerIcon,
  FileDiffIcon,
  FileTextIcon,
  GlobeIcon,
  type IconComponent,
  LinkIcon,
  MoreIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RobotIcon,
  UnlinkIcon,
} from "@hinacode/icons"
import { SubagentProviderIcon } from "./ProviderIcon.tsx"
import {
  checksIndicator,
  pullRequestStatusLabel,
  reviewLabel,
  StatusIcon,
  statusIndicator,
} from "./ThreadPullRequests.tsx"
import {
  StopSubagentButton,
  SubagentStatusIcon,
  SubagentStats,
  useSecondTick,
  useThreadSubagents,
} from "./ThreadAgents.tsx"
import { Button } from "./ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const SUBAGENT_ROWS = 5
const PULL_REQUEST_ROWS = 10

const useThreadProject = (thread: Thread) =>
  AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []).find((candidate) => candidate.id === thread.projectId)

const runInTerminal = (threadId: string) => (command: TerminalCommand) =>
  void useTerminals.getState().openSession(threadId, command)

function useActionRows(thread: Thread, project: Project) {
  const globalActions = useSettings(useThreadEnvironment(thread.id)).actions
  return [
    ...(project.kind === "folder"
      ? project.actions.map((action, index) => ({ action, scope: "project" as const, index }))
      : []),
    ...globalActions.map((action, index) => ({ action, scope: "global" as const, index })),
  ]
}

export function ActionsMenu({ thread }: { thread: Thread }) {
  const project = useThreadProject(thread)
  if (!project) return null
  return <ActionsMenuButton thread={thread} project={project} />
}

function ActionsMenuButton({ thread, project }: { thread: Thread; project: Project }) {
  const rows = useActionRows(thread, project)
  if (rows.length === 0) return null
  const run = runInTerminal(thread.id)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.overview_actions()}
            title={m.overview_actions()}
            className="beside-overview:hidden"
          />
        }
      >
        <PlayIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {rows.map(({ action, scope, index }) => (
          <DropdownMenuItem
            key={`${scope}-${index}`}
            title={action.command}
            onClick={() => run({ title: action.name, line: action.command })}
          >
            <span className="truncate">{action.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ThreadOverview({ thread }: { thread: Thread }) {
  const project = useThreadProject(thread)
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  if (!project) return null
  const live = worktree && worktree.status !== "removed" ? worktree : undefined
  const run = runInTerminal(thread.id)

  return (
    <aside
      aria-label={m.overview_label()}
      className="-m-1 hidden min-h-0 w-70 scroll-fade-y scrollbar-none flex-col overflow-y-auto p-1 beside-overview:flex"
    >
      <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-background/95 p-1.5 shadow-sm backdrop-blur">
        <Environment thread={thread} project={project} worktree={live} />
        <PullRequests thread={thread} worktree={live} />
        {project.kind === "folder" && <SetupScript thread={thread} project={project} worktree={live} onRun={run} />}
        <Actions thread={thread} project={project} onRun={run} />
        <Subagents thread={thread} />
      </div>
    </aside>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-0.5">
      <hr aria-hidden className="mx-2 my-1 border-border" />
      <div className="flex min-h-7 items-center justify-between gap-2 pr-0.5 pl-2">
        <h3 className="truncate text-sm text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

const rowClassName =
  "flex min-h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

function RowButton({
  icon: Icon,
  iconClassName,
  onClick,
  title,
  trailing,
  children,
}: {
  icon: IconComponent
  iconClassName?: string
  onClick: () => void
  title?: string
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <button type="button" title={title} onClick={onClick} className={cn(rowClassName, "hover:bg-muted")}>
      <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", iconClassName)} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  )
}

interface WorkspaceProps {
  readonly thread: Thread
  readonly project: Project
  readonly worktree: Worktree | undefined
}

function Environment({ thread, project, worktree }: WorkspaceProps) {
  const environment = useThreadEnvironment(thread.id)
  const cloud = useCloud(environment)
  const machine = environmentName(environment, useClouds())
  const folder = project.kind === "folder"
  const status = worktree && worktreeStatus[worktree.status]?.()

  return (
    <>
      <h2 className="flex min-h-7 items-center truncate px-2 text-sm text-muted-foreground">
        {m.overview_environment()}
      </h2>
      {folder && (
        <div className={rowClassName} title={project.rootPath}>
          <ProjectIcon projectId={project.id} />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
        </div>
      )}
      <div className={rowClassName}>
        {cloud ? (
          <CloudMark cloud={cloud} className="size-4" />
        ) : (
          <ComputerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{machine}</span>
      </div>
      {worktree && (
        <>
          <div className={rowClassName} title={worktree.path}>
            <BranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{worktree.branch}</span>
            {status && (
              <span
                data-status={worktree.status}
                className="shrink-0 text-xs text-muted-foreground data-[status=failed]:text-destructive"
              >
                {status}
              </span>
            )}
          </div>
          <ChangesRow thread={thread} />
        </>
      )}
    </>
  )
}

function ChangesRow({ thread }: { thread: Thread }) {
  const { changes } = useThreadChanges(thread, "worktree")
  const counts = AsyncResult.isSuccess(changes) && changes.value ? lineCounts(changes.value.patch) : undefined

  return (
    <RowButton
      icon={FileDiffIcon}
      onClick={() => useUi.getState().showView(thread.id, "changes")}
      trailing={counts && <LineCounts added={counts.added} removed={counts.removed} />}
    >
      {m.overview_changes()}
    </RowButton>
  )
}

const SCRIPT_PREVIEW_LINES = 3

function SetupScript({ thread, project, worktree, onRun }: WorkspaceProps & { onRun: RunCommand }) {
  const [editing, setEditing] = useState(false)
  const script = project.setupScript
  const failed = worktree?.status === "failed"
  const edit = () => startTransition(() => setEditing(true))

  return (
    <Section
      title={m.project_setup_label()}
      action={
        script === null && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.overview_setup_add()}
            title={m.overview_setup_add()}
            className="text-muted-foreground"
            onClick={edit}
          >
            <PlusIcon aria-hidden />
          </Button>
        )
      }
    >
      {script !== null && (
        <div>
          <pre title={script} className="mx-1 rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs/relaxed">
            {script
              .split("\n")
              .slice(0, SCRIPT_PREVIEW_LINES)
              .map((line, index) => (
                <span key={index} className="block truncate">
                  {line}
                </span>
              ))}
          </pre>
          <div className="flex items-center gap-0.5 px-1 pt-1">
            <Button variant="ghost" size="xs" onClick={() => onRun({ title: m.project_setup_label(), line: script })}>
              <PlayIcon aria-hidden />
              {m.overview_run()}
            </Button>
            <Button variant="ghost" size="xs" onClick={edit}>
              <PencilIcon aria-hidden />
              {m.overview_edit()}
            </Button>
            {worktree && (
              <Button
                variant="ghost"
                size="xs"
                data-failed={failed}
                className="ml-auto data-[failed=true]:text-destructive"
                onClick={() => useUi.getState().showView(thread.id, "details")}
              >
                {failed ? m.worktree_status_failed() : m.overview_setup_log()}
              </Button>
            )}
          </div>
        </div>
      )}
      <ProjectDialog open={editing} onOpenChange={setEditing} project={project} />
    </Section>
  )
}

function PullRequests({ thread, worktree }: { thread: Thread; worktree: Worktree | undefined }) {
  useAtomValue(loadPullRequestsAtom(thread.id))
  const links = usePullRequests((state) => state.byThreadId[thread.id]) ?? []
  const branchPullRequest = AsyncResult.getOrElse(
    useAtomValue(branchPullRequestAtom(worktree ? worktree.id : null)),
    () => null,
  )
  const linked = new Set(links.map((link) => link.url))
  const urls = [
    ...new Set([...(branchPullRequest ? [branchPullRequest.url] : []), ...links.map((link) => link.url).toReversed()]),
  ]
  const [expanded, setExpanded] = useState(false)
  if (urls.length === 0) return null
  const shown = expanded ? urls : urls.slice(0, PULL_REQUEST_ROWS)

  return (
    <Section title={m.pr_links_title()}>
      <ul className="flex flex-col gap-0.5">
        {shown.map((url) => (
          <li key={url}>
            <PullRequestRow thread={thread} url={url} linked={linked.has(url)} />
          </li>
        ))}
      </ul>
      {urls.length > shown.length && (
        <RowButton
          icon={ChevronDownIcon}
          onClick={() => startTransition(() => setExpanded(true))}
          iconClassName="text-muted-foreground/70"
        >
          <span className="text-muted-foreground">{m.overview_view_all({ count: urls.length })}</span>
        </RowButton>
      )}
    </Section>
  )
}

const openPullRequest = (threadId: string, url: string, tab?: PullRequestTab) => {
  const ui = useUi.getState()
  ui.pickPullRequest(threadId, url)
  ui.setLinkedPullRequestsOpen(false)
  if (tab) ui.setPullRequestTab(tab)
  ui.showView(threadId, "pullRequests")
}

interface PullRequestRowProps {
  readonly thread: Thread
  readonly url: string
  readonly linked: boolean
}

function PullRequestRow({ thread, url, linked }: PullRequestRowProps) {
  const status = useAtomValue(pullRequestStatusAtom(useThreadEnvironment(thread.id), url))
  const pullRequest = AsyncResult.isSuccess(status) ? status.value : undefined
  const name = pullRequest?.title ?? pullRequestName(url)
  const indicator = pullRequest ? statusIndicator[pullRequest.status] : undefined
  const Icon = indicator?.Icon ?? RiGitPullRequestLine
  const rowRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={rowRef} className="group/pr flex items-center rounded-lg hover:bg-muted has-data-popup-open:bg-muted">
      <button
        type="button"
        title={url}
        onClick={() => openPullRequest(thread.id, url)}
        className={cn(rowClassName, "flex-1")}
      >
        <span className="relative flex shrink-0">
          <Icon aria-hidden className={cn("size-4", indicator?.className ?? "text-muted-foreground")} />
          {pullRequest?.checks && <ChecksDot checks={pullRequest.checks} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      <PullRequestMenu
        thread={thread}
        url={url}
        pullRequest={pullRequest}
        linked={linked}
        anchor={rowRef}
        className="mr-1 opacity-0 group-hover/pr:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
      />
    </div>
  )
}

const checksDotColor = {
  passing: "bg-success",
  failing: "bg-destructive",
  pending: "bg-attention",
} satisfies Record<ChecksStatus, string>

function ChecksDot({ checks }: { checks: ChecksStatus }) {
  const label = checksIndicator[checks].label()
  return (
    <span
      title={label}
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background",
        checksDotColor[checks],
      )}
    >
      <span className="sr-only">{label}</span>
    </span>
  )
}

interface PullRequestMenuProps {
  readonly thread: Thread
  readonly url: string
  readonly pullRequest: PullRequest | undefined
  readonly linked: boolean
  readonly anchor: RefObject<HTMLElement | null>
  readonly className?: string
}

function PullRequestMenu({ thread, url, pullRequest, linked, anchor, className }: PullRequestMenuProps) {
  const href = usePullRequestHref(thread.id, url)
  const host = codeHostOfUrl(url)
  const number = pullRequest?.number ?? parsePullRequestUrl(url)?.number ?? parseGitLabMergeRequestUrl(url)?.iid
  const HostIcon = host === "gitlab" ? RiGitlabFill : RiGithubFill
  const unlink = () =>
    callPromise("pullRequests.unlink", { threadId: thread.id, url }).catch((cause: unknown) =>
      toast.error(m.overview_pr_unlink_failed({ message: errorMessage(cause) })),
    )

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.overview_pr_actions()}
                  className={cn("text-muted-foreground", className)}
                />
              }
            />
          }
        >
          <MoreIcon aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{m.overview_pr_actions()}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent anchor={anchor} side="left" align="start" sideOffset={12} className="w-64">
        <div className="flex items-center">
          <DropdownMenuItem className="flex-1" onClick={() => openPullRequest(thread.id, url)}>
            <FileTextIcon aria-hidden />
            {number === undefined
              ? m.overview_pr_view()
              : m.overview_pr_view_number({ number: pullRequestNumberLabel(host, number) })}
          </DropdownMenuItem>
          <DropdownMenuItem
            aria-label={m.overview_pr_copy_link()}
            title={m.overview_pr_copy_link()}
            onClick={() =>
              void navigator.clipboard.writeText(href).then(() => toast.success(m.overview_pr_link_copied()))
            }
          >
            <LinkIcon aria-hidden />
          </DropdownMenuItem>
          <DropdownMenuLinkItem
            href={href}
            target="_blank"
            rel="noreferrer"
            closeOnClick
            aria-label={host === "gitlab" ? m.pr_open_on_gitlab() : m.pr_open_on_github()}
            title={href}
          >
            <HostIcon aria-hidden />
          </DropdownMenuLinkItem>
        </div>
        <DropdownMenuItem onClick={() => openPullRequest(thread.id, url, "files")}>
          <FileDiffIcon aria-hidden />
          <span className="flex-1">{m.overview_pr_code()}</span>
          {pullRequest && <LineCounts added={pullRequest.additions} removed={pullRequest.deletions} />}
        </DropdownMenuItem>
        {pullRequest && (
          <DropdownMenuItem onClick={() => openPullRequest(thread.id, url)}>
            <StatusIcon status={pullRequest.status} className="size-4" />
            {m.overview_pr_status()}
            <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
              {pullRequestMeta(pullRequest)}
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => useDrafts.getState().appendText(thread.id, url)}>
          <ChatNewIcon aria-hidden />
          {m.overview_pr_add_to_chat()}
        </DropdownMenuItem>
        {linked && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void unlink()}>
              <UnlinkIcon aria-hidden />
              {m.overview_pr_unlink()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const pullRequestMeta = (pullRequest: PullRequest) =>
  [pullRequestStatusLabel[pullRequest.status](), pullRequest.review && reviewLabel[pullRequest.review]()]
    .filter(Boolean)
    .join(" · ")

const worktreeStatus: Partial<Record<Worktree["status"], () => string>> = {
  preparing: m.worktree_status_preparing,
  failed: m.worktree_status_failed,
}

type RunCommand = (command: TerminalCommand) => void

function Actions({ thread, project, onRun }: { thread: Thread; project: Project; onRun: RunCommand }) {
  const environment = useThreadEnvironment(thread.id)
  const rows = useActionRows(thread, project)
  const [target, setTarget] = useState<ActionTarget>({ scope: "project", index: null })
  const [dialogOpen, setDialogOpen] = useState(false)
  const projectScoped = project.kind === "folder"
  const edit = (next: ActionTarget) =>
    startTransition(() => {
      setTarget(next)
      setDialogOpen(true)
    })
  if (!projectScoped && rows.length === 0) return null

  return (
    <Section
      title={m.overview_actions()}
      action={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={m.overview_action_add()}
          title={m.overview_action_add()}
          className="text-muted-foreground"
          onClick={() => edit({ scope: projectScoped ? "project" : "global", index: null })}
        >
          <PlusIcon aria-hidden />
        </Button>
      }
    >
      <ul className="flex flex-col gap-0.5">
        {rows.map(({ action, scope, index }) => (
          <li key={`${scope}-${index}`} className="group/action flex items-center rounded-lg hover:bg-muted">
            <button
              type="button"
              title={action.command}
              onClick={() => onRun({ title: action.name, line: action.command })}
              className={cn(rowClassName, "flex-1")}
            >
              <PlayIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{action.name}</span>
              {scope === "global" && (
                <span title={m.action_scope_global()} className="ml-auto flex shrink-0 text-muted-foreground">
                  <GlobeIcon aria-hidden className="size-3.5" />
                  <span className="sr-only">{m.action_scope_global()}</span>
                </span>
              )}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={m.overview_action_edit({ name: action.name })}
              className="mr-1 opacity-0 group-hover/action:opacity-100 focus-visible:opacity-100"
              onClick={() => edit({ scope, index })}
            >
              <PencilIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <ActionDialog
        project={project}
        environment={environment}
        target={target}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </Section>
  )
}

function Subagents({ thread }: { thread: Thread }) {
  const subagents = useThreadSubagents(thread.id).subagents ?? []
  const open = useOpenSubagent(thread.id)
  const now = useSecondTick(subagents.some((subagent) => subagent.status === "running"))
  if (subagents.length === 0) return null
  const shown = subagents.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, SUBAGENT_ROWS)

  return (
    <Section title={m.panel_tab_agents()}>
      <ul className="flex flex-col gap-0.5">
        {shown.map((subagent) => {
          const { callId } = subagent
          return (
            <li key={subagent.id} className="group/agent flex items-center rounded-lg hover:bg-muted">
              <button
                type="button"
                disabled={callId === null}
                onClick={() => callId !== null && open(callId)}
                className={cn(rowClassName, "min-h-9 flex-1 py-0.5")}
              >
                <SubagentProviderIcon subagent={subagent} thread={thread} className="size-4" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm" title={subagent.label}>
                    {subagent.label}
                  </span>
                  <span className="truncate text-xs text-muted-foreground tabular-nums">
                    <SubagentStats thread={thread} subagent={subagent} now={now} />
                  </span>
                </span>
              </button>
              <span className="relative mr-1 flex size-6 shrink-0 items-center justify-center">
                <SubagentStatusIcon
                  status={subagent.status}
                  className={
                    subagent.status === "running"
                      ? "group-focus-within/agent:invisible group-hover/agent:invisible"
                      : undefined
                  }
                />
                {subagent.status === "running" && (
                  <StopSubagentButton
                    threadId={thread.id}
                    subagent={subagent}
                    className="absolute inset-0 opacity-0 group-focus-within/agent:opacity-100 group-hover/agent:opacity-100"
                  />
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {subagents.length > shown.length && (
        <RowButton
          icon={RobotIcon}
          onClick={() => useUi.getState().showView(thread.id, "agents")}
          iconClassName="text-muted-foreground/70"
        >
          <span className="text-muted-foreground">{m.overview_view_all({ count: subagents.length })}</span>
        </RowButton>
      )}
    </Section>
  )
}
