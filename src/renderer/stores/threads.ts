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

/** A project's threads that are not archived, in their saved sidebar order. */
export const selectProjectThreads = (projectId: string) => (state: Pick<ThreadsState, "byId">) =>
  inProject(state, projectId)
    .filter((thread) => thread.status !== "archived")
    .toSorted((a, b) => a.sortIndex - b.sortIndex)

/** A project's archived threads, most recently updated first. */
export const selectArchivedThreads = (projectId: string) => (state: Pick<ThreadsState, "byId">) =>
  inProject(state, projectId)
    .filter((thread) => thread.status === "archived")
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
