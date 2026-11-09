import { useAtomSuspense, useAtomValue } from "@effect/atom-react"
import { Record } from "effect"
import { AsyncResult } from "effect/reactivity"
import { defaultSettings, type InstalledProviders } from "../../shared/domain.ts"
import { binariesAtom, clientSettingsAtom, type EnvironmentId, settingsAtom } from "./rpc.ts"

export const useSettings = (environment: EnvironmentId) =>
  AsyncResult.getOrElse(useAtomValue(settingsAtom(environment)), () => defaultSettings)

export const useAgentBinaries = (environment: EnvironmentId) =>
  AsyncResult.getOrElse(useAtomValue(binariesAtom(environment)), () => undefined)

export const useInstalledProviders = (environment: EnvironmentId): InstalledProviders | undefined => {
  const binaries = useAgentBinaries(environment)
  return binaries && Record.map(binaries, (binary) => binary.installed)
}

export const useClientSettings = () => useAtomSuspense(clientSettingsAtom).value
