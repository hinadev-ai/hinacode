import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { UpdatableProviderId } from "../../shared/agent.ts"

interface DismissedUpdatesState {
  readonly byProvider: Readonly<Partial<Record<UpdatableProviderId, string>>>
  readonly dismiss: (provider: UpdatableProviderId, version: string) => void
}

export const useDismissedUpdates = create<DismissedUpdatesState>()(
  persist(
    (set) => ({
      byProvider: {},
      dismiss: (provider, version) => set((state) => ({ byProvider: { ...state.byProvider, [provider]: version } })),
    }),
    { name: "hinacode.dismissedUpdates", partialize: (state) => ({ byProvider: state.byProvider }) },
  ),
)
