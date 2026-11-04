import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"
import { PRIVATE_NETWORKS } from "../../../shared/domain.ts"

const readSettings = (path: string) => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return Predicate.isObject(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [main] = yield* sql<{ readonly file: string }>`SELECT file FROM pragma_database_list WHERE name = 'main'`
  if (!main?.file) return
  const path = join(dirname(main.file), "settings.json")
  const settings = existsSync(path) ? readSettings(path) : null
  const remote = settings?.["remote"]
  if (settings === null || !Predicate.isObject(remote) || remote["bindHost"] !== null) return
  const temp = `${path}.tmp`
  writeFileSync(
    temp,
    `${JSON.stringify({ ...settings, remote: { ...remote, bindHost: PRIVATE_NETWORKS } }, null, 2)}\n`,
  )
  renameSync(temp, path)
})
