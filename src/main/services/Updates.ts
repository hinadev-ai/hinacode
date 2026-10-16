import { app } from "electron"
import updater from "electron-updater"
import { Context, Effect, Layer, Schedule } from "effect"
import type { UpdateState, UpdateStatus } from "../../shared/domain.ts"
import { Events } from "./Events.ts"

const CHECK_INTERVAL = "4 hours"

/** Checks for releases at launch, every few hours and on request, and downloads them in the background. */
export class Updates extends Context.Service<
  Updates,
  {
    readonly status: Effect.Effect<UpdateStatus>
    /** Does nothing while a check or download runs, or while a downloaded release waits to install. */
    readonly check: Effect.Effect<void>
    readonly install: Effect.Effect<void>
  }
>()("hinacode/Updates") {}

/** For a build that never updates in place: a development build, or a cloud, which is replaced as a binary. */
export const unsupported = (current: string) =>
  Updates.of({
    status: Effect.succeed({ current, state: { type: "unsupported" } }),
    check: Effect.void,
    install: Effect.void,
  })

const make = Effect.gen(function* () {
  const current = app.getVersion()
  if (!app.isPackaged) return unsupported(current)

  // electron-updater is CommonJS and defines `autoUpdater` as a getter, which Node only exposes on the default export.
  const { autoUpdater } = updater
  const events = yield* Events
  let state: UpdateState = { type: "idle" }
  const set = (next: UpdateState) => {
    state = next
    Effect.runFork(events.publish({ type: "update.changed" }))
  }
  autoUpdater.autoDownload = true
  autoUpdater.on("checking-for-update", () => set({ type: "checking" }))
  autoUpdater.on("update-not-available", () => set({ type: "upToDate" }))
  autoUpdater.on("update-available", ({ version }) => set({ type: "downloading", version }))
  autoUpdater.on("update-downloaded", ({ version }) => set({ type: "ready", version }))
  autoUpdater.on("error", (error) => {
    set({ type: "failed", message: error.message })
    Effect.runFork(Effect.logWarning("update failed", error))
  })

  // Failures also arrive as the `error` event above.
  const check = Effect.suspend(() =>
    state.type === "checking" || state.type === "downloading" || state.type === "ready"
      ? Effect.void
      : Effect.tryPromise(() => autoUpdater.checkForUpdates()).pipe(Effect.ignore),
  )
  yield* Effect.repeat(check, Schedule.spaced(CHECK_INTERVAL)).pipe(Effect.forkScoped)

  return Updates.of({
    status: Effect.sync(() => ({ current, state })),
    check,
    install: Effect.sync(() => autoUpdater.quitAndInstall()),
  })
})

export const layer = Layer.effect(Updates, make)
