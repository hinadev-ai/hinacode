import { join } from "node:path"
import { Effect, Option } from "effect"
import { cliSocketPath } from "../main/remote/cliSocketPath.ts"
import { connect } from "./client.ts"
import { unreachableError } from "./exit.ts"

export const NOT_RUNNING = "HinaCode isn't running here. Open the app, or start a cloud with hinacode serve."

export const socketCandidates = (options: {
  readonly dataFlag: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly home: string
}): ReadonlyArray<string> => {
  if (options.dataFlag !== undefined) return [cliSocketPath(options.dataFlag)]
  const dirs = [
    options.env["HINACODE_USER_DATA"] || undefined,
    join(options.home, ".hinacode"),
    join(options.home, ".hinacode-dev"),
    join(options.home, ".hinacode-cloud"),
  ].filter((dir) => dir !== undefined)
  return [...new Set(dirs)].map((dir) => cliSocketPath(dir))
}

export const connectFirst = (candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const socketPath of candidates) {
      const client = yield* connect(socketPath).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NoSocket", () => Effect.succeedNone),
      )
      if (Option.isSome(client)) return client.value
    }
    return yield* unreachableError(NOT_RUNNING)
  })
