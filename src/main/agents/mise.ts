import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { Effect, Option, Schema } from "effect"
import { findBinary } from "./binary.ts"

const execFileAsync = promisify(execFile)

export type MiseOwnership =
  | { readonly kind: "none" }
  | { readonly kind: "manual" }
  | { readonly kind: "upgradable"; readonly mise: string }

const MiseInstalls = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      install_path: Schema.String,
      requested_version: Schema.optional(Schema.NullOr(Schema.String)),
      active: Schema.optional(Schema.Boolean),
    }),
  ),
)

export const runMise = (mise: string, args: ReadonlyArray<string>, timeout = 30_000) =>
  Effect.tryPromise(() =>
    execFileAsync(mise, args, { cwd: homedir(), encoding: "utf8", timeout, killSignal: "SIGKILL" }),
  ).pipe(Effect.map(({ stdout }) => stdout.trim()))

const resolved = (path: string) => Effect.promise(() => realpath(path).catch(() => path))

const isMiseExecScript = (path: string, tool: string) =>
  Effect.promise(async () => {
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size > 64 * 1024) return false
    const script = await readFile(path, "utf8").catch(() => "")
    return script.startsWith("#!") && new RegExp(`\\bmise\\s+(?:x|exec)\\s+["']?${tool}["'@\\s]`).test(script)
  })

const isUnder = (path: string, dir: string) => path.startsWith(`${dir.replace(/\/+$/, "")}/`)

export const miseOwnership = (binary: string, tool: string): Effect.Effect<MiseOwnership> =>
  Effect.gen(function* () {
    const none = { kind: "none" } as const
    const manual = { kind: "manual" } as const
    const mise = yield* Effect.promise(() => findBinary("mise"))
    if (mise === undefined) return none
    const real = yield* resolved(binary)
    const dispatchesThroughMise = /^mise(\.exe)?$/.test(basename(real)) || (yield* isMiseExecScript(real, tool))
    if (dispatchesThroughMise && basename(binary).replace(/\.exe$/, "") !== tool) return manual
    const which = yield* runMise(mise, ["which", tool]).pipe(Effect.option)
    const miseRuns = Option.isSome(which) && which.value !== "" ? yield* resolved(which.value) : undefined
    const launched = dispatchesThroughMise ? miseRuns : real
    if (launched === undefined) return dispatchesThroughMise ? manual : none
    const installs = yield* runMise(mise, ["ls", "--json", "--installed", tool]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MiseInstalls)),
      Effect.orElseSucceed(() => []),
    )
    const owning = yield* Effect.filter(installs, (install) =>
      Effect.map(resolved(install.install_path), (dir) => isUnder(launched, dir)),
    )
    if (owning.length === 0) return dispatchesThroughMise ? manual : none
    const install = owning.find((candidate) => candidate.active === true && candidate.requested_version === "latest")
    if (install === undefined || launched !== miseRuns) return manual
    if (!dispatchesThroughMise) {
      const toolDir = dirname(install.install_path)
      const latestLinks = [toolDir, yield* resolved(toolDir)].map((dir) => join(dir, "latest"))
      if (!latestLinks.some((link) => isUnder(binary, link))) return manual
    }
    return { kind: "upgradable", mise } as const
  })
