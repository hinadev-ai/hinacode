import { create } from "zustand"
import type { ModelInfo, ProviderId } from "@shared/agent.ts"
import { call } from "@/lib/connection"

type ByProvider = Readonly<Partial<Record<ProviderId, readonly ModelInfo[]>>>

interface ModelsState {
  /** By server id, since each machine has its own agents and accounts. `""` is a call that named no server. */
  readonly byServer: Readonly<Record<string, ByProvider>>
  /** Fetches a provider's models on `server` once; rejects when the server could not list them. */
  readonly load: (server: string | undefined, provider: ProviderId) => Promise<void>
}

const inFlight = new Map<string, Promise<void>>()

/** The models each agent offers on each server, cached for the life of the app like the desktop's `modelsAtom`. */
export const useModels = create<ModelsState>()((set, get) => ({
  byServer: {},
  load: (server, provider) => {
    const serverKey = server ?? ""
    if (get().byServer[serverKey]?.[provider] !== undefined) return Promise.resolve()
    const key = `${serverKey}:${provider}`
    const pending =
      inFlight.get(key) ??
      call("models.list", { provider }, { server })
        .then((models) =>
          set((state) => ({
            byServer: { ...state.byServer, [serverKey]: { ...state.byServer[serverKey], [provider]: models } },
          })),
        )
        .finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
    return pending
  },
}))

export const modelsOn = (state: ModelsState, server: string | undefined, provider: ProviderId) =>
  state.byServer[server ?? ""]?.[provider]
