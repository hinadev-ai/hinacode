import { Context, Effect, Layer, Option } from "effect"
import type { AgentAccount } from "../../../shared/agent.ts"
import { Secrets } from "../../services/Secrets.ts"
import { Settings } from "../../services/Settings.ts"
import { makeClaudeHarness } from "../claude/index.ts"
import { AgentError, type AgentProvider, type SessionInput } from "../provider.ts"
import { MAGPIE_KEY_SECRET } from "../../../shared/providers.ts"
import { claudeGatewayEnv, connect, keyFor, magpieModelInfos, modelsOf } from "./gateway.ts"

export class MagpieProvider extends Context.Service<MagpieProvider, AgentProvider>()("hinacode/MagpieProvider") {
  static readonly layer = Layer.effect(
    MagpieProvider,
    Effect.gen(function* () {
      const settings = yield* Settings
      const secrets = yield* Secrets

      const connection = Effect.all({
        endpoint: Effect.map(settings.get, (current) => current.magpieEndpoint),
        saved: Effect.map(secrets.get(MAGPIE_KEY_SECRET), Option.getOrNull),
      }).pipe(
        Effect.flatMap(({ endpoint, saved }) => connect({ endpoint, key: keyFor(endpoint, saved) })),
        Effect.mapError((error) => new AgentError({ provider: "magpie", message: error.message })),
      )

      const listModels = connection.pipe(
        Effect.flatMap(modelsOf),
        Effect.map(magpieModelInfos),
        Effect.orElseSucceed(() => []),
      )

      const launchEnv = ({ model, fastMode }: SessionInput) =>
        Effect.gen(function* () {
          const connected = yield* connection
          const listed = (yield* Effect.orElseSucceed(modelsOf(connected), () => [])).find(
            (candidate) => candidate.id === model,
          )
          return claudeGatewayEnv(connected, listed ?? { id: model }, fastMode)
        })

      const account = () =>
        Effect.match(Effect.flatMap(connection, modelsOf), {
          onFailure: (): AgentAccount => ({ type: "signedOut" }),
          onSuccess: (): AgentAccount => ({ type: "external", service: "magpie" }),
        })

      const harness = yield* makeClaudeHarness({ id: "magpie", listModels, launchEnv })
      return MagpieProvider.of({ ...harness, account, planLimits: () => Effect.succeed(null) })
    }),
  )
}
