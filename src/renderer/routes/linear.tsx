import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Link, useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { RiAddLine, RiRefreshLine } from "react-icons/ri"
import type { LinearIssue } from "../../shared/domain.ts"
import { issueDraft } from "../../shared/linear.ts"
import { Button } from "../components/ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx"
import { errorMessage } from "../lib/errorMessage.ts"
import { formatRelativeTime } from "../lib/relativeTime.ts"
import { linearIssuesAtom, projectsAtom, secretStoredAtom } from "../lib/rpc.ts"
import { startThread } from "../lib/startThread.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"

const priorityLabels: Readonly<Record<number, () => string>> = {
  1: m.linear_priority_1,
  2: m.linear_priority_2,
  3: m.linear_priority_3,
  4: m.linear_priority_4,
}

/** Issues under their workflow state, in the order `sortIssues` put the states. */
function byState(issues: ReadonlyArray<LinearIssue>) {
  const groups = new Map<string, LinearIssue[]>()
  for (const issue of issues) groups.set(issue.state.name, [...(groups.get(issue.state.name) ?? []), issue])
  return [...groups]
}

export function LinearRoute() {
  const issues = useAtomValue(linearIssuesAtom)
  const refresh = useAtomRefresh(linearIssuesAtom)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h1 className="font-heading text-sm font-semibold">{m.linear_title()}</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.linear_refresh()}
          disabled={issues.waiting}
          onClick={refresh}
        >
          <RiRefreshLine aria-hidden className={issues.waiting ? "animate-spin" : undefined} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {AsyncResult.builder(issues)
            .onSuccess((list) => (list.length === 0 ? <EmptyState /> : <IssueGroups issues={list} />))
            .onError((cause) => (
              <p className="text-sm text-destructive">{m.linear_failed({ message: errorMessage(cause) })}</p>
            ))
            .orElse(() => null)}
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  const connected = AsyncResult.getOrElse(useAtomValue(secretStoredAtom(null, "linear.apiKey")), () => true)
  if (connected) return <p className="py-12 text-center text-sm text-muted-foreground">{m.linear_empty()}</p>
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
      {m.linear_not_connected()}
      <Button variant="outline" size="sm" render={<Link to="/settings" search={{ page: "integrations" }} />}>
        {m.linear_connect()}
      </Button>
    </div>
  )
}

function IssueGroups({ issues }: { issues: ReadonlyArray<LinearIssue> }) {
  return byState(issues).map(([state, group]) => (
    <section key={state} className="flex flex-col gap-1">
      <h2 className="flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
        {state}
        <span className="tabular-nums">{group.length}</span>
      </h2>
      <ul className="flex flex-col">
        {group.map((issue) => (
          <IssueRow key={issue.id} issue={issue} />
        ))}
      </ul>
    </section>
  ))
}

function IssueRow({ issue }: { issue: LinearIssue }) {
  const now = useNow()
  const priority = priorityLabels[issue.priority]?.()
  return (
    <li className="group flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
      <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        title={issue.title}
        className="min-w-0 flex-1 truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {issue.title}
      </a>
      {priority && (
        <span className={issue.priority === 1 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {priority}
        </span>
      )}
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {formatRelativeTime(issue.updatedAt, now, getLocale())}
      </span>
      <StartThreadMenu issue={issue} />
    </li>
  )
}

function StartThreadMenu({ issue }: { issue: LinearIssue }) {
  const navigate = useNavigate()
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []).filter(
    (project) => project.kind === "folder",
  )
  if (projects.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.linear_start_thread()}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
          />
        }
      >
        <RiAddLine aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {projects.map((project) => (
          <DropdownMenuItem key={project.id} onClick={() => void startThread(project.id, navigate, issueDraft(issue))}>
            {project.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
