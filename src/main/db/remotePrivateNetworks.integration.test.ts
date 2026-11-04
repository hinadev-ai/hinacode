import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, String } from "effect"
import migrate from "./migrations/0040_remote_private_networks.ts"

const migrated = (settings: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "hinacode-remote-private-"))
  const file = join(dir, "settings.json")
  writeFileSync(file, JSON.stringify(settings))
  return migrate.pipe(
    Effect.provide(
      SqliteClient.layer({
        filename: join(dir, "hinacode.sqlite"),
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      }),
    ),
    Effect.map(() => JSON.parse(readFileSync(file, "utf8"))),
  )
}

describe("a remote listener with no address", () => {
  it.effect("moves to private networks, stays off and keeps the other settings", () =>
    Effect.gen(function* () {
      const settings = { remote: { enabled: false, bindHost: null, port: 48081 }, archive: { whenMerged: true } }
      expect(yield* migrated(settings)).toStrictEqual({
        remote: { enabled: false, bindHost: "private", port: 48081 },
        archive: { whenMerged: true },
      })
    }),
  )

  it.effect("leaves an address the developer already has alone", () =>
    Effect.gen(function* () {
      const settings = { remote: { enabled: true, bindHost: "100.64.0.2", port: 48081 } }
      expect(yield* migrated(settings)).toStrictEqual(settings)
    }),
  )
})
