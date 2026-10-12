import { create } from "zustand"
import type { Thread } from "../../shared/domain.ts"

interface ThreadsState {
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

const settledLast = (thread: Thread) => (thread.status === "settled" ? 1 : 0)

/** A project's threads in sidebar order: saved order, with settled threads moved below the rest. */
export const selectProjectThreads = (projectId: string) => (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => thread.projectId === projectId)
    .toSorted((a, b) => settledLast(a) - settledLast(b) || a.sortIndex - b.sortIndex)
