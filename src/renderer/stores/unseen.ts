import { create } from "zustand"
import { persist } from "zustand/middleware"

/** How a thread's latest turn ended. */
export type Outcome = "completed" | "failed"

interface UnseenState {
  /** Threads whose latest turn ended while the user was not looking, until they open the thread. */
  readonly byThreadId: Readonly<Record<string, Outcome>>
  readonly record: (threadId: string, outcome: Outcome) => void
  readonly clear: (threadId: string) => void
}

/** Persists in localStorage, so a restart keeps the marks. Losing them costs a look at each thread. */
export const useUnseen = create<UnseenState>()(
  persist(
    (set) => ({
      byThreadId: {},
      record: (threadId, outcome) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: outcome } })),
      clear: (threadId) =>
        set((state) => {
          if (!(threadId in state.byThreadId)) return state
          const { [threadId]: _seen, ...rest } = state.byThreadId
          return { byThreadId: rest }
        }),
    }),
    { name: "hinacode.unseen", partialize: (state) => ({ byThreadId: state.byThreadId }) },
  ),
)
