import { create } from "zustand"
import type { Thread } from "../../shared/domain.ts"

export interface ThreadsState {
  readonly byId: Readonly<Record<string, Thread>>
  readonly replaceAll: (threads: ReadonlyArray<Thread>) => void
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
}

/** Threads by id. Loaded once at boot, then kept current by rpc results and `thread.updated` pushes. */
export const useThreads = create<ThreadsState>()((set) => ({
  byId: {},
  replaceAll: (threads) => set({ byId: Object.fromEntries(threads.map((thread) => [thread.id, thread])) }),
  upsert: (thread) => set((state) => ({ byId: { ...state.byId, [thread.id]: thread } })),
  remove: (id) =>
    set((state) => {
      const { [id]: _removed, ...rest } = state.byId
      return { byId: rest }
    }),
}))

const inProject = (state: Pick<ThreadsState, "byId">, projectId: string) =>
  Object.values(state.byId).filter((thread) => thread.projectId === projectId)

const isActive = (thread: Thread) => thread.status !== "archived"
const isPinned = (thread: Thread) => thread.pinnedAt !== null
const newestFirst = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)

/** A project's threads that are not archived, in their saved sidebar order. */
export const selectProjectThreads = (projectId: string) => (state: Pick<ThreadsState, "byId">) =>
  inProject(state, projectId)
    .filter(isActive)
    .toSorted((a, b) => a.sortIndex - b.sortIndex)

/** Like `selectProjectThreads`, without the pinned threads, which the sidebar lists above its tabs. */
export const selectUnpinnedProjectThreads = (projectId: string) => (state: Pick<ThreadsState, "byId">) =>
  selectProjectThreads(projectId)(state).filter((thread) => !isPinned(thread))

/** Active threads of every project that are not pinned, most recently updated first. */
export const selectInboxThreads = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && !isPinned(thread))
    .toSorted(newestFirst)

/** Active pinned threads of every project, in the order they were pinned. */
export const selectPinnedThreads = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && isPinned(thread))
    .toSorted((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))

/** A project's archived threads, most recently updated first. */
export const selectArchivedThreads = (projectId: string) => (state: Pick<ThreadsState, "byId">) =>
  inProject(state, projectId)
    .filter((thread) => !isActive(thread))
    .toSorted(newestFirst)
