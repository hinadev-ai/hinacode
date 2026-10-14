import { app } from "electron"
import updater from "electron-updater"
import { Context, Effect, Layer, Schedule } from "effect"
import { Events } from "./Events.ts"

const CHECK_INTERVAL = "4 hours"

/** Downloads new releases in the background. `ready` is the downloaded version waiting to install, or null. */
export class Updates extends Context.Service<
  Updates,
  { readonly ready: Effect.Effect<string | null>; readonly install: Effect.Effect<void> }
>()("kkcode/Updates") {}

const make = Effect.gen(function* () {
  if (!app.isPackaged) return Updates.of({ ready: Effect.succeed(null), install: Effect.void })

  // electron-updater is CommonJS and defines `autoUpdater` as a getter, which Node only exposes on the default export.
  const { autoUpdater } = updater
  const events = yield* Events
  let ready: string | null = null
  autoUpdater.autoDownload = true
  autoUpdater.on("update-downloaded", ({ version }) => {
    ready = version
    Effect.runFork(events.publish({ type: "update.changed" }))
  })
  autoUpdater.on("error", (error) => {
    ready = null
    Effect.runFork(
      events.publish({ type: "update.changed" }).pipe(Effect.andThen(Effect.logWarning("update failed", error))),
    )
  })

  // Failures also arrive as the `error` event above.
  const check = Effect.tryPromise(() => autoUpdater.checkForUpdates()).pipe(Effect.ignore)
  yield* Effect.repeat(check, Schedule.spaced(CHECK_INTERVAL)).pipe(Effect.forkScoped)

  return Updates.of({
    ready: Effect.sync(() => ready),
    install: Effect.sync(() => autoUpdater.quitAndInstall()),
  })
})

export const layer = Layer.effect(Updates, make)
