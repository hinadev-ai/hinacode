import { execFile } from "node:child_process"
import { readFile, readlink, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
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

const miseLauncher = (path: string, tool: string) =>
  Effect.promise(async (): Promise<"dispatch" | "pinned" | undefined> => {
    if (/^mise(\.exe)?$/.test(basename(path))) return "dispatch"
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size > 64 * 1024) return undefined
    const script = await readFile(path, "utf8").catch(() => "")
    if (!script.startsWith("#!") || !/\bmise\s+(?:x|exec)\b/.test(script)) return undefined
    if (new RegExp(`\\b${tool}@`).test(script)) return "pinned"
    return new RegExp(`\\b${tool}\\b`).test(script) ? "dispatch" : undefined
  })

const linkChain = (path: string) =>
  Effect.promise(async () => {
    const hops = [path]
    while (hops.length < 16) {
      const hop = hops.at(-1) ?? path
      const target = await readlink(hop).catch(() => undefined)
      if (target === undefined) break
      hops.push(resolve(dirname(hop), target))
    }
    return hops
  })

const isUnder = (path: string, dir: string) => path.startsWith(`${dir.replace(/\/+$/, "")}/`)

export const miseOwnership = (binary: string, tool: string): Effect.Effect<MiseOwnership> =>
  Effect.gen(function* () {
    const none = { kind: "none" } as const
    const manual = { kind: "manual" } as const
    const mise = yield* Effect.promise(() => findBinary("mise"))
    if (mise === undefined) return none
    const real = yield* resolved(binary)
    const launcher = yield* miseLauncher(real, tool)
    if (launcher === "pinned") return manual
    const dispatchesThroughMise = launcher === "dispatch"
    if (dispatchesThroughMise && basename(binary).replace(/\.exe$/, "") !== tool) return manual
    const notOwned = dispatchesThroughMise || /\/mise\/installs\/(?!node\/)/.test(real) ? manual : none
    const which = yield* runMise(mise, ["which", tool]).pipe(Effect.option)
    const miseRuns = Option.isSome(which) && which.value !== "" ? yield* resolved(which.value) : undefined
    const launched = dispatchesThroughMise ? miseRuns : real
    if (launched === undefined) return notOwned
    const installs = yield* runMise(mise, ["ls", "--json", "--installed", tool]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MiseInstalls)),
      Effect.orElseSucceed(() => []),
    )
    const owning = yield* Effect.filter(installs, (install) =>
      Effect.map(resolved(install.install_path), (dir) => isUnder(launched, dir)),
    )
    if (owning.length === 0) return notOwned
    const install = owning.find((candidate) => candidate.active === true && candidate.requested_version === "latest")
    if (install === undefined || launched !== miseRuns) return manual
    if (!dispatchesThroughMise) {
      const toolDir = dirname(install.install_path)
      const latestLinks = [toolDir, yield* resolved(toolDir)].map((dir) => join(dir, "latest"))
      const hops = yield* linkChain(binary)
      if (!hops.some((hop) => latestLinks.some((link) => isUnder(hop, link)))) return manual
    }
    return { kind: "upgradable", mise } as const
  })
