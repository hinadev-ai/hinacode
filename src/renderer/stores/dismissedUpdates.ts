import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { UpdatableProviderId } from "../../shared/agent.ts"

interface DismissedUpdatesState {
  /** The latest release whose notice the user closed, per agent. */
  readonly byProvider: Readonly<Partial<Record<UpdatableProviderId, string>>>
  readonly dismiss: (provider: UpdatableProviderId, version: string) => void
}

/** Persists in localStorage, so a closed notice stays closed after a restart until a newer release comes out. */
export const useDismissedUpdates = create<DismissedUpdatesState>()(
  persist(
    (set) => ({
      byProvider: {},
      dismiss: (provider, version) => set((state) => ({ byProvider: { ...state.byProvider, [provider]: version } })),
    }),
    { name: "hinacode.dismissedUpdates", partialize: (state) => ({ byProvider: state.byProvider }) },
  ),
)
