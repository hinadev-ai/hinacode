import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { Outcome } from "../../shared/threadStatus.ts"

interface UnseenState {
  readonly byThreadId: Readonly<Record<string, Outcome>>
  readonly record: (threadId: string, outcome: Outcome) => void
  readonly clear: (threadId: string) => void
}

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
