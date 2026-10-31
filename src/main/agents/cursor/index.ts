import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Context, Effect, Layer } from "effect"
import { providerCli } from "../../../shared/providers.ts"
import { makeAcpProvider } from "../acp/index.ts"
import { installedBinary } from "../binary.ts"
import { AgentError, type AgentProvider } from "../provider.ts"
import { parseCursorStatus } from "./account.ts"

const execFileAsync = promisify(execFile)

const { binary } = providerCli.cursor

const account = Effect.gen(function* () {
  const path = yield* installedBinary("cursor", binary)
  const { stdout } = yield* Effect.tryPromise({
    try: () => execFileAsync(path, ["status"], { encoding: "utf8", timeout: 15_000 }),
    catch: (cause) => new AgentError({ provider: "cursor", message: `\`${binary} status\` failed: ${String(cause)}` }),
  })
  return parseCursorStatus(stdout)
})

export class CursorProvider extends Context.Service<CursorProvider, AgentProvider>()("hinacode/CursorProvider") {
  static readonly layer = Layer.effect(
    CursorProvider,
    makeAcpProvider({
      id: "cursor",
      args: ["acp"],
      env: {},
      authMethod: "cursor_login",
      loginCommand: `${binary} login`,
      account,
    }),
  )
}
