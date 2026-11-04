import { Context, Effect, Layer } from "effect"
import { makeAcpProvider } from "../acp/index.ts"
import { installedBinary } from "../binary.ts"
import { type AgentProvider, MCP_TOOL_TIMEOUT_SECONDS } from "../provider.ts"

export class OpencodeProvider extends Context.Service<OpencodeProvider, AgentProvider>()("hinacode/OpencodeProvider") {
  static readonly layer = Layer.effect(
    OpencodeProvider,
    makeAcpProvider({
      id: "opencode",
      args: ["acp"],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: "ask",
          experimental: { mcp_timeout: MCP_TOOL_TIMEOUT_SECONDS * 1000 },
        }),
      },
      loginCommand: "opencode auth login",
      account: installedBinary("opencode", "opencode").pipe(
        Effect.as({ type: "external", service: "opencode" } as const),
      ),
    }),
  )
}
