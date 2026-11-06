import { Context, Effect, Layer } from "effect"
import type { AgentAccount } from "../../../shared/agent.ts"
import { makeClaudeHarness } from "../claude/index.ts"
import { AgentError, type AgentProvider } from "../provider.ts"
import { claudeGatewayEnv, findGateway, gatewayModels, magpieModelInfos, modelsAt } from "./gateway.ts"

export class MagpieProvider extends Context.Service<MagpieProvider, AgentProvider>()("hinacode/MagpieProvider") {
  static readonly layer = Layer.effect(
    MagpieProvider,
    Effect.gen(function* () {
      const harness = yield* makeClaudeHarness({ id: "magpie", listModels, launchEnv })
      return MagpieProvider.of({ ...harness, account, planLimits: () => Effect.succeed(null) })
    }),
  )
}

const notRunning = new AgentError({
  provider: "magpie",
  message: "magpie is not running. Start the magpie app or `magpie serve`, then try again",
})

const listModels = Effect.map(gatewayModels(), magpieModelInfos)

const launchEnv = (model: string) =>
  Effect.gen(function* () {
    const origin = yield* findGateway()
    if (origin === null) return yield* notRunning
    const listed = (yield* modelsAt(origin)).find((candidate) => candidate.id === model)
    return claudeGatewayEnv(origin, listed ?? { id: model })
  })

const account = () =>
  Effect.map(findGateway(), (origin): AgentAccount =>
    origin === null ? { type: "signedOut" } : { type: "external", service: "magpie" },
  )
