import { create } from "zustand"
import type { ModelInfo, ProviderId } from "@shared/agent.ts"
import { call } from "@/lib/connection"

interface ModelsState {
  readonly byProvider: Readonly<Partial<Record<ProviderId, readonly ModelInfo[]>>>
  /** Fetches a provider's models once; rejects when the desktop could not list them. */
  readonly load: (provider: ProviderId) => Promise<void>
}

const inFlight = new Map<ProviderId, Promise<void>>()

/** The models each agent offers, cached for the life of the app like the desktop's `modelsAtom`. */
export const useModels = create<ModelsState>()((set, get) => ({
  byProvider: {},
  load: (provider) => {
    if (get().byProvider[provider] !== undefined) return Promise.resolve()
    const pending =
      inFlight.get(provider) ??
      call("models.list", { provider })
        .then((models) => set((state) => ({ byProvider: { ...state.byProvider, [provider]: models } })))
        .finally(() => inFlight.delete(provider))
    inFlight.set(provider, pending)
    return pending
  },
}))
