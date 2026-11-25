import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "./client.ts"

const modeOf = (path: string) => statSync(path).mode & 0o777

const databasePath = () => join(mkdtempSync(join(tmpdir(), "hinacode-modes-")), "hinacode.sqlite")

const modesWhileOpen = (path: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO setting (key, value) VALUES ('probe', '1') ON CONFLICT (key) DO NOTHING`
    return [path, `${path}-wal`, `${path}-shm`].map(modeOf)
  }).pipe(Effect.provide(Db.layer(path)))

describe.skipIf(process.platform === "win32")("database file modes", () => {
  it.effect("creates the database, its WAL and its shared memory file readable by the owner only", () =>
    Effect.gen(function* () {
      expect(yield* modesWhileOpen(databasePath())).toStrictEqual([0o600, 0o600, 0o600])
    }),
  )

  it.effect("tightens files an older version left readable by others", () =>
    Effect.gen(function* () {
      const path = databasePath()
      for (const file of [path, `${path}-wal`, `${path}-shm`]) writeFileSync(file, "", { mode: 0o644 })
      chmodSync(path, 0o644)

      expect(yield* modesWhileOpen(path)).toStrictEqual([0o600, 0o600, 0o600])
    }),
  )
})
