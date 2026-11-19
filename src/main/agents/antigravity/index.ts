import { Context, Effect, Layer } from "effect"
import { providerInfo } from "../../../shared/providers.ts"
import { makeAcpProvider } from "../acp/index.ts"
import { installedBinary } from "../binary.ts"
import type { AgentProvider } from "../provider.ts"

export class AntigravityProvider extends Context.Service<AntigravityProvider, AgentProvider>()(
  "hinacode/AntigravityProvider",
) {
  static readonly layer = Layer.effect(
    AntigravityProvider,
    makeAcpProvider({
      id: "antigravity",
      args: ["acp"],
      env: {},
      loginCommand: "agy",
      account: installedBinary("antigravity", providerInfo.antigravity.binary).pipe(
        Effect.as({ type: "external", service: "Antigravity" } as const),
      ),
    }),
  )
}
