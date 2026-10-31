import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, startTransition, useState } from "react"
import type { IconType } from "react-icons"
import {
  RiAddLine,
  RiArrowDownSFill,
  RiComputerLine,
  RiFolder3Line,
  RiGitBranchLine,
  RiGlobalLine,
  RiListView,
  RiPencilLine,
  RiPlayLine,
} from "react-icons/ri"
import type { Project, PullRequest, Thread, Worktree } from "../../shared/domain.ts"
import { useOpenSubagent } from "../lib/subagents.ts"
import { environmentName, useCloud, useClouds, useThreadEnvironment } from "../lib/environments.ts"
import { useSettings } from "../lib/settings.ts"
import { branchPullRequestAtom, projectsAtom, pullRequestStatusAtom } from "../lib/rpc.ts"
import { loadPullRequestsAtom, usePullRequests } from "../stores/pullRequests.ts"
import { m } from "../paraglide/messages.js"
import { type TerminalCommand, useTerminals } from "../stores/terminals.ts"
import { useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { ActionDialog, type ActionTarget } from "./ActionDialog.tsx"
import { CloudMark } from "./CloudMark.tsx"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { ChecksIndicator, pullRequestStatusLabel, reviewLabel, StatusIcon } from "./ThreadPullRequests.tsx"
import { StopSubagentButton, SubagentStatusIcon, subagentStats, useNow, useThreadSubagents } from "./ThreadAgents.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"

export const OVERVIEW_ID = "thread-overview"
const SCRIPT_PREVIEW_LINES = 3
const SUBAGENT_ROWS = 5

export function OverviewToggle() {
  const open = useUi((state) => state.overviewOpen)
  const toggle = useUi((state) => state.toggleOverview)
  const label = open ? m.overview_hide() : m.overview_show()
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={open}
      aria-controls={OVERVIEW_ID}
      data-active={open}
      className="data-[active=true]:bg-muted data-[active=true]:text-foreground"
      onClick={toggle}
    >
      <RiListView aria-hidden />
    </Button>
  )
}

export function ThreadOverview({ thread }: { thread: Thread }) {
  const open = useUi((state) => state.overviewOpen)
  const project = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []).find(
    (candidate) => candidate.id === thread.projectId,
  )
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  if (!open || !project) return null
  const run = (command: TerminalCommand) => void useTerminals.getState().openSession(thread.id, command)

  return (
    <aside
      id={OVERVIEW_ID}
      aria-label={m.overview_label()}
      className="-m-1 flex min-h-0 w-66 flex-col gap-2 overflow-y-auto p-1 [scrollbar-width:none]"
    >
      <Card title={m.overview_environment()}>
        <EnvironmentRows thread={thread} project={project} worktree={worktree} />
      </Card>
      {project.kind === "folder" && (
        <Card title={m.project_setup_label()}>
          <SetupScript thread={thread} project={project} worktree={worktree} onRun={run} />
        </Card>
      )}
      <Actions thread={thread} project={project} onRun={run} />
      <PullRequests thread={thread} worktree={worktree} />
      <Subagents thread={thread} />
    </aside>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border border-border bg-background/95 p-1.5 shadow-sm backdrop-blur"
    >
      <CollapsibleTrigger className="group/card flex items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {title}
        <RiArrowDownSFill
          aria-hidden
          className="size-4 transition-transform group-data-panel-open/card:rotate-0 -rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 pt-0.5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function Row({ icon: Icon, children, trailing }: { icon: IconType; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-sm">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </div>
  )
}

interface WorkspaceProps {
  readonly thread: Thread
  readonly project: Project
  readonly worktree: Worktree | undefined
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

function EnvironmentRows({ thread, project, worktree }: WorkspaceProps) {
  const environment = useThreadEnvironment(thread.id)
  const cloud = useCloud(environment)
  const name = environmentName(environment, useClouds())
  const live = worktree && worktree.status !== "removed" ? worktree : undefined

  return (
    <>
      {cloud ? (
        <div className="flex min-h-8 items-center gap-2 px-2 text-sm">
          <CloudMark cloud={cloud} className="size-4" />
          <span className="truncate">{name}</span>
        </div>
      ) : (
        <Row icon={RiComputerLine}>{name}</Row>
      )}
      {live ? (
        <Row
          icon={RiGitBranchLine}
          trailing={
            <span
              data-status={live.status}
              className="shrink-0 text-xs text-muted-foreground empty:hidden data-[status=failed]:text-destructive"
            >
              {worktreeStatus[live.status]?.()}
            </span>
          }
        >
          <span className="font-mono text-xs" title={live.path}>
            {live.branch}
          </span>
        </Row>
      ) : (
        project.kind === "folder" && (
          <Row icon={RiFolder3Line}>
            <span title={project.rootPath}>{folderName(project.rootPath)}</span>
          </Row>
        )
      )}
    </>
  )
}

const worktreeStatus: Partial<Record<Worktree["status"], () => string>> = {
  preparing: m.worktree_status_preparing,
  failed: m.worktree_status_failed,
}

interface SetupScriptProps extends WorkspaceProps {
  readonly onRun: (command: TerminalCommand) => void
}

function SetupScript({ thread, project, worktree, onRun }: SetupScriptProps) {
  const [editing, setEditing] = useState(false)
  const script = project.setupScript
  const failed = worktree?.status === "failed"

  return (
    <>
      {script === null ? (
        <AddRow label={m.overview_setup_add()} onClick={() => startTransition(() => setEditing(true))} />
      ) : (
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
              <RiPlayLine aria-hidden />
              {m.overview_run()}
            </Button>
            <Button variant="ghost" size="xs" action={() => setEditing(true)}>
              <RiPencilLine aria-hidden />
              {m.overview_edit()}
            </Button>
            {worktree && worktree.status !== "removed" && (
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
    </>
  )
}

function Actions({ thread, project, onRun }: ActionsProps) {
  const environment = useThreadEnvironment(thread.id)
  const globalActions = useSettings(environment).actions
  const [target, setTarget] = useState<ActionTarget>({ scope: "project", index: null })
  const [dialogOpen, setDialogOpen] = useState(false)
  const projectScoped = project.kind === "folder"
  const edit = (next: ActionTarget) =>
    startTransition(() => {
      setTarget(next)
      setDialogOpen(true)
    })
  const rows = [
    ...(projectScoped ? project.actions.map((action, index) => ({ action, scope: "project" as const, index })) : []),
    ...globalActions.map((action, index) => ({ action, scope: "global" as const, index })),
  ]
  if (!projectScoped && rows.length === 0) return null

  return (
    <Card title={m.overview_actions()}>
      <ul className="flex flex-col gap-0.5">
        {rows.map(({ action, scope, index }) => (
          <li key={`${scope}-${index}`} className="group/action flex items-center rounded-md hover:bg-muted">
            <button
              type="button"
              title={action.command}
              onClick={() => onRun({ title: action.name, line: action.command })}
              className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RiPlayLine aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{action.name}</span>
              {scope === "global" && (
                <span title={m.action_scope_global()} className="ml-auto flex shrink-0 text-muted-foreground">
                  <RiGlobalLine aria-hidden className="size-3.5" />
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
              <RiPencilLine aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <AddRow
        label={m.overview_action_add()}
        onClick={() => edit({ scope: projectScoped ? "project" : "global", index: null })}
      />
      <ActionDialog
        project={project}
        environment={environment}
        target={target}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </Card>
  )
}

interface ActionsProps {
  readonly thread: Thread
  readonly project: Project
  readonly onRun: (command: TerminalCommand) => void
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RiAddLine aria-hidden className="size-4 shrink-0" />
      {label}
    </button>
  )
}

function Subagents({ thread }: { thread: Thread }) {
  const subagents = useThreadSubagents(thread.id).subagents ?? []
  const open = useOpenSubagent(thread.id)
  const now = useNow(subagents.some((subagent) => subagent.status === "running"))
  if (subagents.length === 0) return null
  const shown = subagents.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, SUBAGENT_ROWS)

  return (
    <Card title={m.agents_list_label()}>
      <ul className="flex flex-col gap-0.5">
        {shown.map((subagent) => {
          const { callId } = subagent
          return (
            <li key={subagent.id} className="group/agent flex items-center rounded-md hover:bg-muted">
              <button
                type="button"
                disabled={callId === null}
                onClick={() => callId !== null && open(callId)}
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SubagentStatusIcon status={subagent.status} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm" title={subagent.label}>
                    {subagent.label}
                  </span>
                  <span className="truncate text-xs text-muted-foreground tabular-nums">
                    {subagentStats(subagent, now)}
                  </span>
                </span>
              </button>
              {subagent.status === "running" && (
                <StopSubagentButton
                  threadId={thread.id}
                  subagent={subagent}
                  className="mr-1 opacity-0 group-focus-within/agent:opacity-100 group-hover/agent:opacity-100"
                />
              )}
            </li>
          )
        })}
      </ul>
      {subagents.length > shown.length && (
        <Button
          variant="ghost"
          size="xs"
          className="mx-1 self-start text-muted-foreground"
          onClick={() => useUi.getState().showView(thread.id, "agents")}
        >
          {m.overview_agents_all({ count: subagents.length })}
        </Button>
      )}
    </Card>
  )
}

function PullRequests({ thread, worktree }: { thread: Thread; worktree: Worktree | undefined }) {
  useAtomValue(loadPullRequestsAtom(thread.id))
  const links = usePullRequests((state) => state.byThreadId[thread.id]) ?? []
  const live = worktree !== undefined && worktree.status !== "removed"
  const branchPullRequest = AsyncResult.getOrElse(
    useAtomValue(branchPullRequestAtom(live ? worktree.id : null)),
    () => null,
  )
  const urls = [
    ...new Set([...(branchPullRequest ? [branchPullRequest.url] : []), ...links.map((link) => link.url).toReversed()]),
  ]
  if (urls.length === 0) return null

  return (
    <Card title={m.pr_links_title()}>
      <ul className="flex flex-col gap-0.5">
        {urls.map((url) => (
          <PullRequestRow key={url} thread={thread} url={url} />
        ))}
      </ul>
    </Card>
  )
}

const pullRequestNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? url

const pullRequestMeta = (pullRequest: PullRequest) =>
  [pullRequestStatusLabel[pullRequest.status](), pullRequest.review && reviewLabel[pullRequest.review]()]
    .filter(Boolean)
    .join(" · ")

function PullRequestRow({ thread, url }: { thread: Thread; url: string }) {
  const status = useAtomValue(pullRequestStatusAtom(useThreadEnvironment(thread.id), url))
  const pullRequest = AsyncResult.isSuccess(status) ? status.value : undefined

  return (
    <li>
      <button
        type="button"
        title={url}
        onClick={() => {
          useUi.getState().pickPullRequest(thread.id, url)
          useUi.getState().showView(thread.id, "pullRequests")
        }}
        className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StatusIcon status={pullRequest?.status} colored className="size-4" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{pullRequest?.title ?? url}</span>
          <span className="truncate text-xs text-muted-foreground">
            <span className="font-mono">#{pullRequest?.number ?? pullRequestNumber(url)}</span>
            {pullRequest && ` · ${pullRequestMeta(pullRequest)}`}
          </span>
        </span>
        {pullRequest?.checks && <ChecksIndicator checks={pullRequest.checks} />}
      </button>
    </li>
  )
}
