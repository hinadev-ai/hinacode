import type { RpcRequest } from "@shared/contract.ts"
import { inboxGroup, rowState } from "@shared/threadStatus.ts"
import { create } from "zustand"
import { isThreadBusy, type Project, type Thread, type Worktree } from "@shared/domain.ts"
import { call } from "@/lib/connection"
import { errorText } from "@/lib/error-text"

interface ThreadsState {
  readonly projects: readonly Project[]
  readonly worktrees: Readonly<Record<string, Worktree>>
  /** The branch checked out in each project's root, by project id, once read. */
  readonly branches: Readonly<Record<string, string>>
  readonly byId: Readonly<Record<string, Thread>>
  /** When this phone saw each busy thread's turn begin, see `trackRunningSince`. */
  readonly runningSince: Readonly<Record<string, string>>
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

export const useThreads = create<ThreadsState>()((set, get) => {
  let pushedDuringLoad: Map<string, Thread | null> | null = null
  let worktreesPushedDuringLoad: Map<string, Worktree> | null = null

  const readBranch = (projectId: string) =>
    call("projects.currentBranch", { id: projectId }).then(
      (branch) => set((state) => ({ branches: { ...state.branches, [projectId]: branch } })),
      // A folder that is not a git repository has no branch to show.
      () => {},
    )

  return {
    projects: [],
    worktrees: {},
    branches: {},
    byId: {},
    runningSince: {},
    status: "loading",
    error: null,
    load: async () => {
      const ownPushed = new Map<string, Thread | null>()
      const ownWorktrees = new Map<string, Worktree>()
      pushedDuringLoad = ownPushed
      worktreesPushedDuringLoad = ownWorktrees
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
          worktrees: {
            ...Object.fromEntries(worktrees.map((worktree) => [worktree.id, worktree])),
            ...Object.fromEntries(ownWorktrees),
          },
          byId,
          runningSince: trackRunningSince(get().runningSince, Object.values(byId)),
          status: "ready",
          error: null,
        })
        for (const project of projects) void readBranch(project.id)
      } catch (cause) {
        if (pushedDuringLoad === ownPushed) set({ status: "error", error: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        if (pushedDuringLoad === ownPushed) pushedDuringLoad = null
        if (worktreesPushedDuringLoad === ownWorktrees) worktreesPushedDuringLoad = null
      }
    },
    upsert: (thread) => {
      const previous = get().byId[thread.id]
      pushedDuringLoad?.set(thread.id, thread)
      set((state) => {
        const byId = { ...state.byId, [thread.id]: thread }
        return { byId, runningSince: trackRunningSince(state.runningSince, Object.values(byId)) }
      })
      // A turn in the project root may have switched its branch.
      const turnEnded = previous !== undefined && isThreadBusy(previous.status) && !isThreadBusy(thread.status)
      if (turnEnded && thread.worktreeId === null) void readBranch(thread.projectId)
      // The desktop pushes no project changes, so a thread from an unknown project means one was added there.
      const { status, projects } = get()
      if (pushedDuringLoad === null && status === "ready" && !projects.some((project) => project.id === thread.projectId))
        void get().load()
    },
    remove: (id) => {
      pushedDuringLoad?.set(id, null)
      set((state) => {
        const { [id]: _removed, ...byId } = state.byId
        return { byId }
      })
    },
    upsertWorktree: (worktree) => {
      worktreesPushedDuringLoad?.set(worktree.id, worktree)
      set((state) => ({ worktrees: { ...state.worktrees, [worktree.id]: worktree } }))
    },
    addProject: (project) =>
      set((state) => ({ projects: [...state.projects.filter((existing) => existing.id !== project.id), project] })),
  }
})

/**
 * Keeps the time each busy thread's turn began. The thread records none, so a turn the phone sees begin takes the
 * `updatedAt` of that change, and later updates during the turn, such as a model switch, leave it alone.
 */
export function trackRunningSince(
  since: Readonly<Record<string, string>>,
  threads: readonly Thread[],
): Readonly<Record<string, string>> {
  const next: Record<string, string> = {}
  for (const thread of threads) if (isThreadBusy(thread.status)) next[thread.id] = since[thread.id] ?? thread.updatedAt
  return next
}

/** Every thread but the drafts New thread opens, which the server lists only after their first message. */
export const listedThreads = (byId: Readonly<Record<string, Thread>>) =>
  Object.values(byId).filter((thread) => thread.status !== "draft")

/** A project's threads in the order the developer arranged them in the desktop sidebar. */
export const sortThreads = (threads: readonly Thread[]) => [...threads].sort((a, b) => a.sortIndex - b.sortIndex)

const newestFirst = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

/** Pinned threads, in the order they were pinned. */
export const pinnedThreads = (threads: readonly Thread[]) =>
  threads
    .filter((thread) => thread.pinnedAt !== null && thread.status !== "archived")
    .sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))

/** The desktop's inbox rule: a settled thread leaves the inbox, unless it is working again. */
const inboxGroupOf = (thread: Thread) => inboxGroup(rowState(thread.status, false, undefined, undefined), thread.settledAt)

/**
 * Every active thread that is not pinned, newest activity first, as on the desktop. A thread that starts waiting
 * for the developer is updated then, so it rises to the top on its own.
 */
export const inboxThreads = (threads: readonly Thread[]) =>
  threads.filter((thread) => thread.pinnedAt === null && inboxGroupOf(thread) === "ready").sort(newestFirst)

export const settledThreads = (threads: readonly Thread[]) =>
  threads.filter((thread) => thread.pinnedAt === null && inboxGroupOf(thread) === "settled").sort(newestFirst)

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

/**
 * The branch a thread works on: its worktree's, or the one checked out in the project root. A removed worktree's
 * branch is still named, marked removed, since the thread now works in the project root.
 */
export function threadBranch(
  worktree: Worktree | undefined,
  rootBranch: string | undefined,
): { readonly name: string; readonly removed: boolean } | null {
  const name = worktree?.branch ?? rootBranch ?? ""
  return name === "" ? null : { name, removed: worktree?.status === "removed" }
}

export const useThreadRoot = (thread: Thread) =>
  useThreads((state) => threadRoot(thread, state.projects, state.worktrees))

/** The name of the branch a thread works on, or undefined before it is known. */
export const useThreadBranchName = (thread: Thread) =>
  useThreads(
    (state) =>
      threadBranch(
        thread.worktreeId === null ? undefined : state.worktrees[thread.worktreeId],
        state.branches[thread.projectId],
      )?.name,
  )

/** Saves a change to a thread and shows the desktop's answer, or hands the error to `onError`. */
export const updateThread = async (patch: RpcRequest<"threads.update">, onError: (message: string) => void) => {
  try {
    useThreads.getState().upsert(await call("threads.update", patch))
  } catch (cause) {
    onError(errorText(cause))
  }
}
