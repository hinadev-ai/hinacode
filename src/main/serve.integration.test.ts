import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { PRIVATE_NETWORKS } from "../shared/domain.ts"
import * as Db from "./db/client.ts"
import { RemoteAccess } from "./remote/access.ts"
import * as RemoteAccessModule from "./remote/access.ts"
import { makeEventsLayer } from "./services/Events.ts"
import { Secrets } from "./services/Secrets.ts"
import * as SecretsModule from "./services/Secrets.ts"
import { Settings } from "./services/Settings.ts"
import * as SettingsModule from "./services/Settings.ts"
import { applyServeConfig } from "./serve.ts"

const testLayer = RemoteAccessModule.layer.pipe(
  Layer.provideMerge(SecretsModule.layer),
  Layer.provideMerge(Layer.suspend(() => SettingsModule.layer(mkdtempSync(join(tmpdir(), "kk-serve-settings-"))))),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      SecretsModule.noKeyring,
      makeEventsLayer(() => {}),
    ),
  ),
)

describe("serve mode boot", () => {
  it.effect("turns the listener settings on, keeps its key across restarts, and resets pairing on request", () =>
    Effect.gen(function* () {
      const access = yield* RemoteAccess
      yield* applyServeConfig({ bindHost: "127.0.0.1", port: 49152, resetPairing: false })
      const first = yield* access.pairing
      expect(first.port).toBe(49152)
      expect(first.key).toHaveLength(43)
      expect(first.secret).toHaveLength(43)

      const settings = yield* Settings.use((service) => service.get)
      expect(settings.remote).toStrictEqual({ enabled: true, bindHost: "127.0.0.1", port: 49152 })

      yield* applyServeConfig({ resetPairing: false })
      const restarted = yield* access.pairing
      expect(restarted).toStrictEqual(first)

      yield* applyServeConfig({ resetPairing: true })
      const reset = yield* access.pairing
      expect(reset.key).not.toBe(first.key)
      expect(reset.secret).not.toBe(first.secret)
      expect(yield* Secrets.use((service) => service.has("remote.token"))).toBe(false)
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("without --host, listens on private networks and then keeps the address it was given", () =>
    Effect.gen(function* () {
      yield* applyServeConfig({ resetPairing: false })
      expect((yield* Settings.use((service) => service.get)).remote.bindHost).toBe(PRIVATE_NETWORKS)
      yield* applyServeConfig({ resetPairing: false, bindHost: "100.64.0.2" })
      yield* applyServeConfig({ resetPairing: false })
      expect((yield* Settings.use((service) => service.get)).remote.bindHost).toBe("100.64.0.2")
    }).pipe(Effect.provide(testLayer)),
  )
})
