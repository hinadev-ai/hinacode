import { create } from "zustand"
import type { Outcome } from "@/lib/row-state"

interface UnseenState {
  /** Threads whose latest turn ended while the developer was not looking, until they open the thread. */
  readonly byThreadId: Readonly<Record<string, Outcome>>
  readonly record: (threadId: string, outcome: Outcome) => void
  readonly clear: (threadId: string) => void
}

/** Kept in memory: the phone only hears turns end while it runs, and losing the marks costs a look at each thread. */
export const useUnseen = create<UnseenState>()((set) => ({
  byThreadId: {},
  record: (threadId, outcome) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: outcome } })),
  clear: (threadId) =>
    set((state) => {
      if (!(threadId in state.byThreadId)) return state
      const { [threadId]: _seen, ...rest } = state.byThreadId
      return { byThreadId: rest }
    }),
}))
