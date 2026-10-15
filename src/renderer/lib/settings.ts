import { useAtomSuspense, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { defaultSettings } from "../../shared/domain.ts"
import { clientSettingsAtom, type EnvironmentId, settingsAtom } from "./rpc.ts"

/**
 * Settings of one environment. Defaults until a cloud answers, or while it is offline, so its threads still render.
 * The settings route shows an environment's pages only once its settings loaded, so pages never save over defaults.
 */
export const useSettings = (environment: EnvironmentId) =>
  AsyncResult.getOrElse(useAtomValue(settingsAtom(environment)), () => defaultSettings)

/** Settings of this desktop. Never suspends in practice: main.tsx loads them before the first render. */
export const useClientSettings = () => useAtomSuspense(clientSettingsAtom).value
