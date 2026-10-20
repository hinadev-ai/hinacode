import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { Thread } from "../../shared/domain.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { projectsAtom } from "./rpc.ts"

export interface ThreadRoot {
  readonly path: string
  /** Set when `path` is a live worktree. */
  readonly worktreeId: string | null
}

/**
 * Where the thread works now: its worktree, or the project root once the worktree is removed. Undefined until
 * the projects and worktrees load, so a worktree thread never briefly points at the project root.
 */
export function useThreadRoot(thread: Thread): ThreadRoot | undefined {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const projects = useAtomValue(projectsAtom)
  const project = AsyncResult.getOrElse(projects, () => []).find((candidate) => candidate.id === thread.projectId)
  const live = worktree?.status === "removed" ? undefined : worktree
  const path = live?.path ?? project?.rootPath
  if (path === undefined || (thread.worktreeId !== null && worktree === undefined)) return undefined
  return { path, worktreeId: live?.id ?? null }
}
