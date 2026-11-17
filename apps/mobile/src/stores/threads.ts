import type { RpcRequest } from "@shared/contract.ts"
import { inboxGroup, rowState } from "@shared/threadStatus.ts"
import { create } from "zustand"
import { isThreadBusy, type Project, type Thread, type Worktree } from "@shared/domain.ts"
import { call } from "@/lib/connection"
import { errorText } from "@/lib/error-text"

interface ThreadsState {
  readonly projects: readonly Project[]
  readonly worktrees: Readonly<Record<string, Worktree>>
  readonly branches: Readonly<Record<string, string>>
  readonly byId: Readonly<Record<string, Thread>>
  readonly runningSince: Readonly<Record<string, string>>
  readonly status: "loading" | "ready" | "error"
  readonly error: string | null
  readonly load: () => Promise<void>
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
  readonly upsertWorktree: (worktree: Worktree) => void
  readonly addProject: (project: Project) => void
}

export const useThreads = create<ThreadsState>()((set, get) => {
  let pushedDuringLoad: Map<string, Thread | null> | null = null
  let worktreesPushedDuringLoad: Map<string, Worktree> | null = null

  const readBranch = (projectId: string) =>
    call("projects.currentBranch", { id: projectId }).then(
      (branch) => set((state) => ({ branches: { ...state.branches, [projectId]: branch } })),
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
      const turnEnded = previous !== undefined && isThreadBusy(previous.status) && !isThreadBusy(thread.status)
      if (turnEnded && thread.worktreeId === null) void readBranch(thread.projectId)
      const { status, projects } = get()
      const fromProjectAddedOnDesktop = !projects.some((project) => project.id === thread.projectId)
      if (pushedDuringLoad === null && status === "ready" && fromProjectAddedOnDesktop)
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

export function trackRunningSince(
  since: Readonly<Record<string, string>>,
  threads: readonly Thread[],
): Readonly<Record<string, string>> {
  const next: Record<string, string> = {}
  for (const thread of threads) if (isThreadBusy(thread.status)) next[thread.id] = since[thread.id] ?? thread.updatedAt
  return next
}

export const listedThreads = (byId: Readonly<Record<string, Thread>>) =>
  Object.values(byId).filter((thread) => thread.status !== "draft")

export const draftThread = (byId: Readonly<Record<string, Thread>>, id: string | undefined) => {
  const thread = id === undefined ? undefined : byId[id]
  return thread?.status === "draft" ? thread : undefined
}

export const sortThreads = (threads: readonly Thread[]) => [...threads].sort((a, b) => a.sortIndex - b.sortIndex)

const newestFirst = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

export const pinnedThreads = (threads: readonly Thread[]) =>
  threads
    .filter((thread) => thread.pinnedAt !== null && thread.status !== "archived")
    .sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))

const inboxGroupOf = (thread: Thread) => inboxGroup(rowState(thread, false, undefined, undefined), thread.settledAt)

export const inboxThreads = (threads: readonly Thread[]) =>
  threads.filter((thread) => thread.pinnedAt === null && inboxGroupOf(thread) === "ready").sort(newestFirst)

export const settledThreads = (threads: readonly Thread[]) =>
  threads.filter((thread) => thread.pinnedAt === null && inboxGroupOf(thread) === "settled").sort(newestFirst)

export const archivedThreads = (threads: readonly Thread[]) =>
  threads.filter((thread) => thread.status === "archived").sort(newestFirst)

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

export function threadBranch(
  worktree: Worktree | undefined,
  rootBranch: string | undefined,
): { readonly name: string; readonly removed: boolean } | null {
  const name = worktree?.branch ?? rootBranch ?? ""
  return name === "" ? null : { name, removed: worktree?.status === "removed" }
}

export const useThreadRoot = (thread: Thread) =>
  useThreads((state) => threadRoot(thread, state.projects, state.worktrees))

export const useThreadBranchName = (thread: Thread) =>
  useThreads(
    (state) =>
      threadBranch(
        thread.worktreeId === null ? undefined : state.worktrees[thread.worktreeId],
        state.branches[thread.projectId],
      )?.name,
  )

export const updateThread = async (patch: RpcRequest<"threads.update">, onError: (message: string) => void) => {
  try {
    useThreads.getState().upsert(await call("threads.update", patch))
  } catch (cause) {
    onError(errorText(cause))
  }
}
