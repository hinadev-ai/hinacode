import { create } from "zustand"
import type { Project, Thread, Worktree } from "@shared/domain.ts"
import { call } from "@/lib/connection"

interface ThreadsState {
  readonly projects: readonly Project[]
  readonly worktrees: Readonly<Record<string, Worktree>>
  readonly byId: Readonly<Record<string, Thread>>
  readonly status: "loading" | "ready" | "error"
  readonly error: string | null
  /**
   * Reads projects, worktrees and threads again on every handshake, since pushes were missed while offline. A
   * thread pushedDuringLoad while the read was in flight keeps whichever copy is newer.
   */
  readonly load: () => Promise<void>
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
  readonly upsertWorktree: (worktree: Worktree) => void
  /** The desktop pushes no project changes, so a project this phone added is put in place here. */
  readonly addProject: (project: Project) => void
}

export const useThreads = create<ThreadsState>()((set) => {
  let pushedDuringLoad: Map<string, Thread | null> | null = null

  return {
    projects: [],
    worktrees: {},
    byId: {},
    status: "loading",
    error: null,
    load: async () => {
      const ownPushed = new Map<string, Thread | null>()
      pushedDuringLoad = ownPushed
      try {
        const [projects, worktrees, threads] = await Promise.all([
          call("projects.list", undefined),
          call("worktrees.list", undefined),
          call("threads.list", undefined),
        ])
        if (pushedDuringLoad !== ownPushed) return
        const byId: Record<string, Thread> = Object.fromEntries(threads.map((thread) => [thread.id, thread]))
        for (const [id, thread] of ownPushed) {
          if (thread === null) delete byId[id]
          else if (byId[id] === undefined || byId[id].updatedAt <= thread.updatedAt) byId[id] = thread
        }
        set({
          projects,
          worktrees: Object.fromEntries(worktrees.map((worktree) => [worktree.id, worktree])),
          byId,
          status: "ready",
          error: null,
        })
      } catch (cause) {
        if (pushedDuringLoad === ownPushed) set({ status: "error", error: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        if (pushedDuringLoad === ownPushed) pushedDuringLoad = null
      }
    },
    upsert: (thread) => {
      pushedDuringLoad?.set(thread.id, thread)
      set((state) => ({ byId: { ...state.byId, [thread.id]: thread } }))
    },
    remove: (id) => {
      pushedDuringLoad?.set(id, null)
      set((state) => {
        const { [id]: _removed, ...byId } = state.byId
        return { byId }
      })
    },
    upsertWorktree: (worktree) => set((state) => ({ worktrees: { ...state.worktrees, [worktree.id]: worktree } })),
    addProject: (project) =>
      set((state) => ({ projects: [...state.projects.filter((existing) => existing.id !== project.id), project] })),
  }
})

export const needsHuman = (thread: Thread) => thread.status === "awaiting_approval" || thread.status === "limited"

const rank = (thread: Thread) =>
  needsHuman(thread) ? 0 : thread.status === "archived" ? 2 : 1

/** The desktop sidebar order, with threads that need a human moved to the top. */
export const sortThreads = (threads: readonly Thread[]) =>
  [...threads].sort((a, b) => rank(a) - rank(b) || a.sortIndex - b.sortIndex)

const newestFirst = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

/** Pinned threads, in the order they were pinned. */
export const pinnedThreads = (threads: readonly Thread[]) =>
  threads
    .filter((thread) => thread.pinnedAt !== null && thread.status !== "archived")
    .sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))

/** Every active thread that is not pinned, threads that need a human first, then the latest activity. */
export const inboxThreads = (threads: readonly Thread[]) =>
  threads
    .filter((thread) => thread.pinnedAt === null && thread.status !== "archived")
    .sort((a, b) => Number(needsHuman(b)) - Number(needsHuman(a)) || newestFirst(a, b))

export const archivedThreads = (threads: readonly Thread[]) =>
  threads.filter((thread) => thread.status === "archived").sort(newestFirst)

/** Threads whose title or project name contains every word of `query`, ignoring case. Archived threads last. */
export function matchThreads(threads: readonly Thread[], projects: readonly Project[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "")
  if (words.length === 0) return []
  const projectNames = new Map(projects.map((project) => [project.id, project.name.toLowerCase()]))
  return threads
    .filter((thread) => {
      const haystack = `${thread.title.toLowerCase()} ${projectNames.get(thread.projectId) ?? ""}`
      return words.every((word) => haystack.includes(word))
    })
    .sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || newestFirst(a, b))
}

/**
 * The folder a thread works in: its worktree while that exists, else the project root. `fs.*` and
 * `fs.preview` accept only these roots. Null until the thread's worktree has loaded.
 */
export function threadRoot(
  thread: Thread,
  projects: readonly Project[],
  worktrees: Readonly<Record<string, Worktree>>,
): string | null {
  const project = projects.find((candidate) => candidate.id === thread.projectId)
  if (thread.worktreeId === null) return project?.rootPath ?? null
  const worktree = worktrees[thread.worktreeId]
  if (worktree === undefined) return null
  return worktree.status === "removed" ? (project?.rootPath ?? null) : worktree.path
}

export const useThreadRoot = (thread: Thread) =>
  useThreads((state) => threadRoot(thread, state.projects, state.worktrees))
