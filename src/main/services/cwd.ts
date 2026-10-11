import { Effect } from "effect"
import { Projects } from "./Projects.ts"
import { Threads } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"

/**
 * The directory a thread's agent runs in: its worktree, or the project root when it has none.
 *
 * Removing a worktree keeps `thread.worktreeId` pointing at the removed row so the history still
 * shows where the thread ran. From then on the thread runs in the project root.
 */
export const resolveThreadCwd = (threadId: string) =>
  Effect.gen(function* () {
    const thread = yield* Threads.use((threads) => threads.get(threadId))
    const { worktreeId } = thread
    if (worktreeId) {
      const worktree = yield* Worktrees.use((worktrees) => worktrees.get(worktreeId))
      if (worktree.status !== "removed") return worktree.path
    }
    const project = yield* Projects.use((projects) => projects.get(thread.projectId))
    return project.rootPath
  })
