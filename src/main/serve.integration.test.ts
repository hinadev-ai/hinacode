import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as Db from "./db/client.ts"
import { RemoteAccess } from "./remote/access.ts"
import * as RemoteAccessModule from "./remote/access.ts"
import { Secrets } from "./services/Secrets.ts"
import * as SecretsModule from "./services/Secrets.ts"
import { Settings } from "./services/Settings.ts"
import * as SettingsModule from "./services/Settings.ts"
import { applyServeConfig } from "./serve.ts"

const testLayer = RemoteAccessModule.layer.pipe(
  Layer.provideMerge(SecretsModule.layer),
  Layer.provideMerge(Layer.suspend(() => SettingsModule.layer(mkdtempSync(join(tmpdir(), "kk-serve-settings-"))))),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(Layer.mergeAll(NodeServices.layer, SecretsModule.noKeyring)),
)

describe("serve mode boot", () => {
  it.effect("turns the listener settings on, reuses its token across restarts, and rotates on request", () =>
    Effect.gen(function* () {
      const access = yield* RemoteAccess
      yield* applyServeConfig({ bindHost: "127.0.0.1", port: 49152, rotateToken: false })
      const first = yield* access.pairing
      expect(first.port).toBe(49152)
      expect(first.token).not.toBe("")

      const settings = yield* Settings.use((service) => service.get)
      expect(settings.remote).toStrictEqual({ enabled: true, bindHost: "127.0.0.1", port: 49152 })
      expect(access.authenticate(first.token)).toBe(true)
      expect(access.authenticate("not-the-token")).toBe(false)

      yield* applyServeConfig({ rotateToken: false })
      const restarted = yield* access.pairing
      expect(restarted.token).toBe(first.token)
      expect(restarted.port).toBe(49152)

      yield* applyServeConfig({ rotateToken: true })
      const rotated = yield* access.pairing
      expect(rotated.token).not.toBe(first.token)
      expect(access.authenticate(first.token)).toBe(false)
      expect(access.authenticate(rotated.token)).toBe(true)
      expect(yield* Secrets.use((service) => service.has("remote.token"))).toBe(true)
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("without --host, listens on the Tailscale address and then keeps it", () =>
    Effect.gen(function* () {
      yield* applyServeConfig({ rotateToken: false }, () => "100.64.0.2")
      expect((yield* Settings.use((service) => service.get)).remote.bindHost).toBe("100.64.0.2")
      yield* applyServeConfig({ rotateToken: false }, () => "100.64.0.9")
      expect((yield* Settings.use((service) => service.get)).remote.bindHost).toBe("100.64.0.2")
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("refuses to start without --host on a machine with no Tailscale address", () =>
    Effect.gen(function* () {
      const error = yield* applyServeConfig({ rotateToken: false }, () => null).pipe(Effect.flip)
      expect(error._tag).toBe("ServeHostRequired")
      expect(error.message).toContain("--host")
      expect((yield* Settings.use((service) => service.get)).remote.enabled).toBe(false)
    }).pipe(Effect.provide(testLayer)),
  )
})
