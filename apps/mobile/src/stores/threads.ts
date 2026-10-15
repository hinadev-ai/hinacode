import { create } from "zustand"
import type { Project, Thread } from "@shared/domain.ts"
import { call } from "@/lib/connection"

interface ThreadsState {
  readonly projects: readonly Project[]
  readonly byId: Readonly<Record<string, Thread>>
  readonly status: "loading" | "ready" | "error"
  readonly error: string | null
  /**
   * Reads projects and threads again on every handshake, since pushes were missed while offline. A thread pushed
   * while the read was in flight keeps whichever copy is newer.
   */
  readonly load: () => Promise<void>
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
}

export const useThreads = create<ThreadsState>()((set) => {
  /** Threads pushed while `load` waits, which the list it gets back may predate. */
  let pushed: Map<string, Thread | null> | null = null

  return {
    projects: [],
    byId: {},
    status: "loading",
    error: null,
    load: async () => {
      const ownPushed = new Map<string, Thread | null>()
      pushed = ownPushed
      try {
        const [projects, threads] = await Promise.all([call("projects.list", undefined), call("threads.list", undefined)])
        if (pushed !== ownPushed) return
        const byId: Record<string, Thread> = Object.fromEntries(threads.map((thread) => [thread.id, thread]))
        for (const [id, thread] of ownPushed) {
          if (thread === null) delete byId[id]
          else if (byId[id] === undefined || byId[id].updatedAt <= thread.updatedAt) byId[id] = thread
        }
        set({ projects, byId, status: "ready", error: null })
      } catch (cause) {
        // A failed reload keeps the threads on screen.
        if (pushed === ownPushed) set({ status: "error", error: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        if (pushed === ownPushed) pushed = null
      }
    },
    upsert: (thread) => {
      pushed?.set(thread.id, thread)
      set((state) => ({ byId: { ...state.byId, [thread.id]: thread } }))
    },
    remove: (id) => {
      pushed?.set(id, null)
      set((state) => {
        const { [id]: _removed, ...byId } = state.byId
        return { byId }
      })
    },
  }
})

export const needsHuman = (thread: Thread) => thread.status === "awaiting_approval" || thread.status === "limited"

const rank = (thread: Thread) =>
  needsHuman(thread) ? 0 : thread.status === "archived" ? 2 : 1

/** The desktop sidebar order, with threads that need a human moved to the top. */
export const sortThreads = (threads: readonly Thread[]) =>
  [...threads].sort((a, b) => rank(a) - rank(b) || a.sortIndex - b.sortIndex)
