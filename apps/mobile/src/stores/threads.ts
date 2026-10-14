import { create } from "zustand"
import type { Project, Thread } from "@shared/domain.ts"
import { call } from "@/lib/connection"

interface ThreadsState {
  readonly projects: readonly Project[]
  readonly byId: Readonly<Record<string, Thread>>
  readonly status: "loading" | "ready" | "error"
  readonly error: string | null
  /** Reads projects and threads again; called on every (re)connect, since pushes were missed while offline. */
  readonly load: () => Promise<void>
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
}

export const useThreads = create<ThreadsState>()((set) => ({
  projects: [],
  byId: {},
  status: "loading",
  error: null,
  load: async () => {
    try {
      const [projects, threads] = await Promise.all([call("projects.list", undefined), call("threads.list", undefined)])
      set({
        projects,
        byId: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
        status: "ready",
        error: null,
      })
    } catch (cause) {
      set({ status: "error", error: cause instanceof Error ? cause.message : String(cause) })
    }
  },
  upsert: (thread) => set((state) => ({ byId: { ...state.byId, [thread.id]: thread } })),
  remove: (id) =>
    set((state) => {
      const { [id]: _removed, ...byId } = state.byId
      return { byId }
    }),
}))

export const needsHuman = (thread: Thread) => thread.status === "awaiting_approval" || thread.status === "limited"

const rank = (thread: Thread) =>
  needsHuman(thread) ? 0 : thread.status === "archived" ? 2 : 1

/** The desktop sidebar order, with threads that need a human moved to the top. */
export const sortThreads = (threads: readonly Thread[]) =>
  [...threads].sort((a, b) => rank(a) - rank(b) || a.sortIndex - b.sortIndex)
