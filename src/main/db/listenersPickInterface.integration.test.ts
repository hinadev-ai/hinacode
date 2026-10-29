import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Settings } from "../services/Settings.ts"
import * as SettingsModule from "../services/Settings.ts"
import * as Db from "./client.ts"
import { migrate } from "./migrations/0027_listeners_pick_interface.ts"

const testLayer = SettingsModule.layer.pipe(Layer.provideMerge(Db.layer(":memory:")), Layer.provide(NodeServices.layer))

const saveWildcards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO setting (key, value) VALUES
    ('remote', ${JSON.stringify({ enabled: true, bindHost: "0.0.0.0", port: 48081 })}),
    ('automations', ${JSON.stringify({ bindHost: "0.0.0.0", port: 48080 })})`
})

describe("listeners that bound every interface", () => {
  it.effect("move to the Tailscale address and keep remote control on", () =>
    Effect.gen(function* () {
      yield* saveWildcards
      yield* migrate("100.64.0.2")
      const { remote, automations } = yield* Settings.use((settings) => settings.get)
      expect(remote).toStrictEqual({ enabled: true, bindHost: "100.64.0.2", port: 48081 })
      expect(automations).toStrictEqual({ bindHost: "100.64.0.2", port: 48080 })
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect(
    "without Tailscale, turn remote control off until an interface is picked, and webhooks fall back to loopback",
    () =>
      Effect.gen(function* () {
        yield* saveWildcards
        yield* migrate(null)
        const { remote, automations } = yield* Settings.use((settings) => settings.get)
        expect(remote).toStrictEqual({ enabled: false, bindHost: null, port: 48081 })
        expect(automations).toStrictEqual({ bindHost: "127.0.0.1", port: 48080 })
      }).pipe(Effect.provide(testLayer)),
  )

  it.effect("leave a picked address alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO setting (key, value) VALUES
        ('remote', ${JSON.stringify({ enabled: true, bindHost: "192.0.2.10", port: 48081 })})`
      yield* migrate("100.64.0.2")
      expect((yield* Settings.use((settings) => settings.get)).remote.bindHost).toBe("192.0.2.10")
    }).pipe(Effect.provide(testLayer)),
  )
})

describe("settings", () => {
  it.effect("start with remote control off and no interface picked", () =>
    Effect.gen(function* () {
      expect((yield* Settings.use((settings) => settings.get)).remote).toStrictEqual({
        enabled: false,
        bindHost: null,
        port: 48081,
      })
    }).pipe(Effect.provide(testLayer)),
  )
})
