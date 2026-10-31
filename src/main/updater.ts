import { app } from "electron"
import updater from "electron-updater"
import { Effect, Layer, Schedule } from "effect"
import type { UpdateState } from "../shared/domain.ts"
import { Events } from "./services/Events.ts"
import { unsupported, Updates } from "./services/Updates.ts"

const CHECK_INTERVAL = "4 hours"

const make = Effect.gen(function* () {
  const current = app.getVersion()
  if (!app.isPackaged) return unsupported(current)

  // FIXME: electron-updater is CommonJS, so Node exposes the `autoUpdater` getter only on the default export
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
