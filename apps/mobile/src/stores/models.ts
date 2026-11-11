import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { ModelInfo, ProviderId } from "@shared/agent.ts"
import { call } from "@/lib/connection"
import { familyOf, beforeFirstHandshake } from "@/lib/remote"

type ByProvider = Readonly<Partial<Record<ProviderId, readonly ModelInfo[]>>>

interface ModelsState {
  readonly byServer: Readonly<Record<string, ByProvider>>
  readonly load: (
    server: string | undefined,
    provider: ProviderId,
    options?: { readonly force?: boolean },
  ) => Promise<void>
}

const inFlight = new Map<string, Promise<void>>()

export const useModels = create<ModelsState>()((set, get) => ({
  byServer: {},
  load: (server, provider, options) => {
    const serverKey = server ?? ""
    if (options?.force !== true && get().byServer[serverKey]?.[provider] !== undefined) return Promise.resolve()
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

const loadAtom = familyOf((server: string | null, provider: ProviderId, force: boolean) =>
  Atom.make((get) => {
    if (beforeFirstHandshake(get)) return Effect.never
    return Effect.tryPromise({
      try: () => useModels.getState().load(server ?? undefined, provider, { force }),
      catch: (cause) => cause,
    })
  }),
)

export const modelsLoadAtom = (server: string | undefined, provider: ProviderId) =>
  loadAtom(server ?? null, provider, false)

export const modelsRelistAtom = (server: string | undefined, provider: ProviderId) =>
  loadAtom(server ?? null, provider, true)
