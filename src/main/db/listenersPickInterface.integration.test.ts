import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, String } from "effect"
import { Settings } from "../services/Settings.ts"
import * as SettingsModule from "../services/Settings.ts"
import { migrate } from "./migrations/0029_listeners_pick_interface.ts"

/** A data directory with `settings.json` holding `settings`, and the migration run against the database beside it. */
const migrated = (settings: unknown, tailscale: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "kk-pick-interface-"))
  const file = join(dir, "settings.json")
  writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings))
  return migrate(tailscale).pipe(
    Effect.provide(
      SqliteClient.layer({
        filename: join(dir, "hinacode.sqlite"),
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      }),
    ),
    Effect.as({ dir, read: () => readFileSync(file, "utf8") }),
  )
}

const wildcards = {
  remote: { enabled: true, bindHost: "0.0.0.0", port: 48081 },
  automations: { bindHost: "0.0.0.0", port: 48080 },
  archive: { whenMerged: true },
}

describe("listeners that bound every interface", () => {
  it.effect("move to the Tailscale address, keep remote control on and keep the other settings", () =>
    Effect.gen(function* () {
      const { read } = yield* migrated(wildcards, "100.64.0.2")
      expect(JSON.parse(read())).toStrictEqual({
        remote: { enabled: true, bindHost: "100.64.0.2", port: 48081 },
        automations: { bindHost: "100.64.0.2", port: 48080 },
        archive: { whenMerged: true },
      })
    }),
  )

  it.effect(
    "without Tailscale, turn remote control off until an interface is picked, and webhooks fall back to loopback",
    () =>
      Effect.gen(function* () {
        const { dir } = yield* migrated(wildcards, null)
        const { remote, automations } = yield* Settings.use((settings) => settings.get).pipe(
          Effect.provide(SettingsModule.layer(dir)),
        )
        expect(remote).toStrictEqual({ enabled: false, bindHost: null, port: 48081 })
        expect(automations).toStrictEqual({ bindHost: "127.0.0.1", port: 48080 })
      }),
  )

  it.effect("leave a picked address, and a file a hand edit broke, as they are", () =>
    Effect.gen(function* () {
      const picked = `{"remote":{"enabled":true,"bindHost":"192.0.2.10","port":48081}}`
      expect((yield* migrated(picked, "100.64.0.2")).read()).toBe(picked)
      expect((yield* migrated(`{"remote": `, "100.64.0.2")).read()).toBe(`{"remote": `)
    }),
  )
})

describe("remote settings", () => {
  it.effect("start off with no interface picked, and read a hand-edited 0.0.0.0 the same way", () =>
    Effect.gen(function* () {
      const fresh = mkdtempSync(join(tmpdir(), "kk-pick-interface-"))
      const edited = mkdtempSync(join(tmpdir(), "kk-pick-interface-"))
      writeFileSync(join(edited, "settings.json"), JSON.stringify({ remote: wildcards.remote }))
      for (const dir of [fresh, edited]) {
        const { remote } = yield* Settings.use((settings) => settings.get).pipe(
          Effect.provide(SettingsModule.layer(dir)),
        )
        expect(remote).toStrictEqual({ enabled: false, bindHost: null, port: 48081 })
      }
    }),
  )
})
