import { useAtomValue } from "@effect/atom-react"
import { createContext } from "react"
import { AsyncResult } from "effect/reactivity"
import { type Thread, threadFolder } from "../../shared/domain.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { projectsAtom } from "./rpc.ts"

export interface ThreadRoot {
  readonly path: string
  readonly worktreeId: string | null
}

export function useThreadRoot(thread: Thread): ThreadRoot | undefined {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const projects = useAtomValue(projectsAtom)
  const project = AsyncResult.getOrElse(projects, () => []).find((candidate) => candidate.id === thread.projectId)
  const live = worktree?.status === "removed" ? undefined : worktree
  const path = live?.path ?? (project && threadFolder(project, thread.sideOf ?? thread.id))
  if (path === undefined || (thread.worktreeId !== null && worktree === undefined)) return undefined
  return { path, worktreeId: live?.id ?? null }
}

export const ThreadFolder = createContext<string | null>(null)
