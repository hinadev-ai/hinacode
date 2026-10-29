import { useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useActionState, useState } from "react"
import { RiChat3Line, RiDeleteBinLine } from "react-icons/ri"
import { useShallow } from "zustand/react/shallow"
import { type CheckoutState, isThreadBusy, type Project, type Thread, type Worktree } from "../../../shared/domain.ts"
import { environmentName, useClouds } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, projectsAtom, worktreeCheckoutsAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useThreads } from "../../stores/threads.ts"
import { useWorktrees } from "../../stores/worktrees.ts"
import { Badge } from "../ui/badge.tsx"
import { Button } from "../ui/button.tsx"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog.tsx"
import { ArchiveSettings } from "./ArchiveSettings.tsx"
import { SettingsSection, settingsGroupClass } from "./SettingsSection.tsx"
import { WorktreeRootField } from "./WorktreeRootField.tsx"

type Blocker = "setup" | "turn"

interface WorktreeRow {
  readonly worktree: Worktree
  readonly threads: ReadonlyArray<Thread>
  readonly checkout: CheckoutState | undefined
  readonly blocker: Blocker | undefined
}

interface ProjectGroup {
  readonly projectId: string
  readonly project: Project | undefined
  readonly rows: ReadonlyArray<WorktreeRow>
}

const noProjects: ReadonlyArray<Project> = []
const noCheckouts: ReadonlyMap<string, CheckoutState> = new Map()

const blockerOf = (worktree: Worktree, threads: ReadonlyArray<Thread>): Blocker | undefined =>
  worktree.status === "preparing" ? "setup" : threads.some((thread) => isThreadBusy(thread.status)) ? "turn" : undefined

const groupByProject = (
  worktrees: ReadonlyArray<Worktree>,
  threads: ReadonlyArray<Thread>,
  projects: ReadonlyArray<Project>,
  checkouts: ReadonlyMap<string, CheckoutState>,
): ReadonlyArray<ProjectGroup> => {
  const groups = new Map<string, Array<WorktreeRow>>()
  for (const worktree of worktrees) {
    const users = threads.filter((thread) => thread.worktreeId === worktree.id)
    const row = { worktree, threads: users, checkout: checkouts.get(worktree.id), blocker: blockerOf(worktree, users) }
    groups.set(worktree.projectId, [...(groups.get(worktree.projectId) ?? []), row])
  }
  return [...groups].map(([projectId, rows]) => ({
    projectId,
    project: projects.find((project) => project.id === projectId),
    rows,
  }))
}

type BadgeKey = "dirty" | "missing" | "failed" | Blocker

const badgeText: Record<BadgeKey, () => string> = {
  dirty: m.settings_worktree_dirty,
  missing: m.settings_worktree_missing,
  failed: m.settings_worktree_failed,
  setup: m.settings_worktree_preparing,
  turn: m.settings_worktree_running,
}

const badgesOf = ({ worktree, checkout, blocker }: WorktreeRow): ReadonlyArray<BadgeKey> => [
  ...(checkout === "dirty" || checkout === "missing" ? [checkout] : []),
  ...(worktree.status === "failed" ? (["failed"] as const) : []),
  ...(blocker === undefined ? [] : [blocker]),
]

export function WorktreeSettings() {
  return (
    <div className="flex flex-col gap-12">
      <Worktrees />
      <ArchiveSettings />
    </div>
  )
}

function Worktrees() {
  const worktrees = useWorktrees(
    useShallow((state) => Object.values(state.byId).filter((worktree) => worktree.status !== "removed")),
  )
  const threads = useThreads(useShallow((state) => Object.values(state.byId)))
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => noProjects)
  const checkouts = AsyncResult.getOrElse(useAtomValue(worktreeCheckoutsAtom), () => noCheckouts)
  const groups = groupByProject(worktrees, threads, projects, checkouts)

  return (
    <SettingsSection title={m.settings_worktrees()} description={m.settings_worktrees_description()}>
      <WorktreeRootField />
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.settings_worktrees_empty()}</p>
      ) : (
        groups.map((group) => <ProjectWorktrees key={group.projectId} group={group} />)
      )}
    </SettingsSection>
  )
}

function ProjectWorktrees({ group }: { group: ProjectGroup }) {
  const clouds = useClouds()
  const environment = group.project?.environmentId ?? null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex min-w-0 items-baseline gap-2 px-1 text-sm font-medium">
        <span className="truncate">{group.project?.name ?? m.settings_worktree_unknown_project()}</span>
        {clouds.length > 0 && (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            {environmentName(environment, clouds)}
          </span>
        )}
      </h3>
      <ul className={settingsGroupClass}>
        {group.rows.map((row) => (
          <WorktreeItem key={row.worktree.id} row={row} />
        ))}
      </ul>
    </div>
  )
}

function WorktreeItem({ row }: { row: WorktreeRow }) {
  const { worktree, threads, blocker } = row
  const [removing, setRemoving] = useState(false)

  return (
    <li className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-mono text-sm font-medium break-all">{worktree.branch}</span>
          {badgesOf(row).map((key) => (
            <Badge key={key} variant={key === "dirty" ? "destructive" : "secondary"}>
              {badgeText[key]()}
            </Badge>
          ))}
        </div>
        <p className="font-mono text-xs break-all text-muted-foreground">{worktree.path}</p>
        <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {threads.length === 0
            ? m.settings_worktree_no_threads()
            : threads.map((thread) => (
                <Link
                  key={thread.id}
                  to="/thread/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex max-w-full min-w-0 items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  <RiChat3Line aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{thread.title}</span>
                </Link>
              ))}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        disabled={blocker !== undefined}
        aria-label={m.settings_worktree_remove({ branch: worktree.branch })}
        onClick={() => setRemoving(true)}
      >
        <RiDeleteBinLine aria-hidden />
      </Button>
      <RemoveWorktreeDialog row={row} open={removing} onOpenChange={setRemoving} />
    </li>
  )
}

interface RemoveWorktreeDialogProps {
  readonly row: WorktreeRow
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function RemoveWorktreeDialog({ row, open, onOpenChange }: RemoveWorktreeDialogProps) {
  const { worktree, threads, checkout } = row
  const [error, remove, isPending] = useActionState<string | null>(async () => {
    try {
      useWorktrees
        .getState()
        .upsert(await callPromise("worktrees.remove", { id: worktree.id, deleteBranch: "ifMerged" }))
    } catch (cause) {
      return errorMessage(cause)
    }
    onOpenChange(false)
    return null
  }, null)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">
            {m.worktree_remove_title({ branch: worktree.branch })}
          </AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {m.worktree_remove_body({ path: worktree.path })}
          </AlertDialogDescription>
          {checkout === "dirty" && (
            <AlertDialogDescription className="font-medium text-destructive">
              {m.worktree_remove_dirty()}
            </AlertDialogDescription>
          )}
          <AlertDialogDescription>
            {m.worktree_remove_branch({ branch: worktree.branch, base: worktree.baseRef })}
          </AlertDialogDescription>
          {threads.length > 0 && (
            <AlertDialogDescription>{m.worktree_remove_threads({ count: threads.length })}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} action={remove}>
            {m.worktree_remove_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
