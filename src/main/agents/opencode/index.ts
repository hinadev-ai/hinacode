import { Context, Effect, Layer } from "effect"
import { makeAcpProvider } from "../acp/index.ts"
import type { AgentProvider } from "../provider.ts"

export class OpencodeProvider extends Context.Service<OpencodeProvider, AgentProvider>()("hinacode/OpencodeProvider") {
  static readonly layer = Layer.effect(
    OpencodeProvider,
    makeAcpProvider({
      id: "opencode",
      args: ["acp"],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "ask" }) },
      authMethod: null,
      loginCommand: "opencode auth login",
      account: Effect.succeed({ type: "external", service: "opencode" }),
    }),
  )
}
