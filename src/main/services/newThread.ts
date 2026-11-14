import type { ProviderId } from "../../shared/agent.ts"
import { Effect } from "effect"
import { startingProvider } from "../../shared/domain.ts"
import { installedProviders } from "../agents/binary.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { Settings } from "./Settings.ts"

export const newThreadProvider = Effect.gen(function* () {
  const settings = yield* Settings.use((service) => service.get)
  return startingProvider(settings, yield* installedProviders)
})

export const newThreadOptions = (provider: ProviderId) =>
  Effect.gen(function* () {
    const settings = yield* Settings.use((service) => service.get)
    const model =
      settings.defaultModel[provider] ?? (yield* AgentRunner.use((runner) => runner.listModels(provider)))[0]?.id ?? ""
    return { model, effort: settings.defaultEffort[provider], fastMode: settings.defaultFastMode[provider] }
  })
