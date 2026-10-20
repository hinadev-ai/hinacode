import { execFile } from "node:child_process"
import { basename, delimiter, dirname } from "node:path"
import { promisify } from "node:util"
import { Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import type { UpdateState } from "../shared/domain.ts"
import { Events } from "./services/Events.ts"
import { unsupported, Updates } from "./services/Updates.ts"

const execFileAsync = promisify(execFile)

const CHECK_INTERVAL = "4 hours"
const INSTALL_TIMEOUT_MS = 10 * 60_000

const NpmRelease = Schema.Struct({ version: Schema.String })

export interface CloudUpdaterOptions {
  readonly current: string
  /** The installed `hinacode` package, two levels above `out/main/daemon.js`. */
  readonly packageRoot: string
  readonly registry: string
  /** Stops the cloud and starts the installed release in its place. */
  readonly restart: () => void
}

/** The prefix `npm install -g` used, when `packageRoot` is a global install at `<prefix>/lib/node_modules/hinacode`. */
const globalPrefix = (packageRoot: string) => {
  const nodeModules = dirname(packageRoot)
  const lib = dirname(nodeModules)
  const isGlobal = basename(packageRoot) === "hinacode" && basename(nodeModules) === "node_modules"
  return isGlobal && basename(lib) === "lib" ? dirname(lib) : undefined
}

const make = ({ current, packageRoot, registry, restart }: CloudUpdaterOptions) =>
  Effect.gen(function* () {
    const prefix = globalPrefix(packageRoot)
    // `process.execve`, which restarts in place, does not exist on Windows.
    if (prefix === undefined || process.platform === "win32") return unsupported(current)

    const events = yield* Events
    let state: UpdateState = { type: "idle" }
    const set = (next: UpdateState) =>
      Effect.suspend(() => {
        state = next
        return events.publish({ type: "update.changed" })
      })

    const latest = Effect.tryPromise(async () => {
      const response = await fetch(`${registry.replace(/\/$/, "")}/hinacode/latest`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`npm answered ${response.status}`)
      return Schema.decodeUnknownSync(NpmRelease)(await response.json()).version
    })

    // A check asked for during the scheduled one waits for it, so its caller reads a settled state.
    const checkLock = yield* Semaphore.make(1)
    const check = Effect.suspend(() =>
      state.type === "downloading"
        ? Effect.void
        : set({ type: "checking" }).pipe(
            Effect.andThen(latest),
            Effect.matchEffect({
              onFailure: (error) => set({ type: "failed", message: `Could not check for updates: ${error.message}` }),
              onSuccess: (version) => set(version === current ? { type: "upToDate" } : { type: "ready", version }),
            }),
          ),
    ).pipe(checkLock.withPermit)

    // npm's shebang runs the first `node` on PATH, so put the node that runs this cloud first.
    const npmEnv = { ...process.env, PATH: [dirname(process.execPath), process.env["PATH"]].join(delimiter) }
    const npmInstall = (version: string) =>
      Effect.tryPromise({
        try: () =>
          execFileAsync(
            "npm",
            [
              "install",
              "--global",
              `--prefix=${prefix}`,
              `--registry=${registry}`,
              // npm 11 skips install scripts it was not told to run, and node-pty's picks its prebuilt binary.
              "--allow-scripts=node-pty",
              `hinacode@${version}`,
            ],
            { env: npmEnv, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS },
          ),
        catch: (cause) =>
          new Error((cause as { stderr?: string }).stderr?.trim().split("\n").slice(-3).join("\n") || String(cause)),
      })

    const install = Effect.suspend(() => {
      if (state.type !== "ready") return Effect.void
      const { version } = state
      return set({ type: "downloading", version }).pipe(
        Effect.andThen(
          npmInstall(version).pipe(
            Effect.matchEffect({
              onFailure: (error) => set({ type: "failed", message: error.message }),
              onSuccess: () => Effect.sync(restart),
            }),
            // The caller's rpc returns now; the cloud restarts once npm finishes.
            Effect.forkDetach,
          ),
        ),
      )
    })

    yield* Effect.repeat(check, Schedule.spaced(CHECK_INTERVAL)).pipe(Effect.forkScoped)

    return Updates.of({
      status: Effect.sync(() => ({ current, state })),
      check,
      install,
    })
  })

/** Updates for `hinacode serve`: checks npm, and installs the release in place of the running one. */
export const layer = (options: CloudUpdaterOptions) => Layer.effect(Updates, make(options))
