import { EventEmitter } from "node:events"
import { expect, it } from "@effect/vitest"
import updater from "electron-updater"
import { Effect, Layer, Queue } from "effect"
import { vi } from "vitest"
import type { PushEvent } from "../../shared/contract.ts"
import { Events } from "./Events.ts"
import { layer, Updates } from "./Updates.ts"

vi.mock("electron", () => ({ app: { isPackaged: true, getVersion: () => "0.1.0" } }))
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: Object.assign(new EventEmitter(), {
      autoDownload: false,
      checkForUpdates: () => Promise.resolve(null),
      quitAndInstall: () => {},
    }),
  },
}))

it.effect("clears a rejected update and tells the renderer to refresh the status", () =>
  Effect.gen(function* () {
    const pushes = yield* Queue.unbounded<PushEvent>()
    const events = Layer.succeed(Events, {
      publish: (event) => Queue.offer(pushes, event).pipe(Effect.asVoid),
    })
    yield* Effect.gen(function* () {
      const updates = yield* Updates
      yield* Effect.sync(() =>
        updater.autoUpdater.emit("update-downloaded", {
          version: "0.1.1",
          files: [],
          path: "update.zip",
          sha512: "fixture",
          releaseDate: "2026-10-14T00:00:00.000Z",
          downloadedFile: "/tmp/update.zip",
        }),
      )
      expect(yield* updates.status).toEqual({ current: "0.1.0", state: { type: "ready", version: "0.1.1" } })
      const downloaded = yield* Queue.take(pushes)
      yield* Effect.sync(() => updater.autoUpdater.emit("error", new Error("Code signature did not pass validation")))
      expect((yield* updates.status).state).toEqual({
        type: "failed",
        message: "Code signature did not pass validation",
      })
      const rejected = yield* Queue.take(pushes)
      expect([downloaded, rejected]).toEqual([{ type: "update.changed" }, { type: "update.changed" }])
    }).pipe(Effect.provide(layer.pipe(Layer.provide(events))))
  }),
)
