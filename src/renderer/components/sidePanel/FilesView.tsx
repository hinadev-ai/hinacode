import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { Thread } from "../../../shared/domain.ts"
import { projectsAtom } from "../../lib/rpc.ts"
import { useWorktrees } from "../../stores/worktrees.ts"
import { FileExplorer } from "../FileExplorer.tsx"

/** The files of where the thread works now: its worktree, or the project root once the worktree is removed. */
export function FilesView({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const projects = useAtomValue(projectsAtom)
  const project = AsyncResult.getOrElse(projects, () => []).find((candidate) => candidate.id === thread.projectId)
  const live = worktree?.status === "removed" ? undefined : worktree
  const root = live?.path ?? project?.rootPath
  // Until worktrees load, a worktree thread would briefly list the project root instead.
  if (root === undefined || (thread.worktreeId !== null && worktree === undefined)) return null
  return <FileExplorer key={root} thread={thread} root={root} worktreeId={live?.id ?? null} />
}
