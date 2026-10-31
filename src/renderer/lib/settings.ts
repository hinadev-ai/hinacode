import { useAtomSuspense, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { defaultSettings } from "../../shared/domain.ts"
import { clientSettingsAtom, type EnvironmentId, settingsAtom } from "./rpc.ts"

export const useSettings = (environment: EnvironmentId) =>
  AsyncResult.getOrElse(useAtomValue(settingsAtom(environment)), () => defaultSettings)

export const useClientSettings = () => useAtomSuspense(clientSettingsAtom).value
