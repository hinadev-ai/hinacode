import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"
import { tailscaleAddress } from "../../network.ts"

const isWildcard = (host: unknown) => host === "0.0.0.0" || host === "::"

/**
 * Listeners no longer bind every interface. One saved on 0.0.0.0 moves to the Tailscale address. Without one, the
 * webhook listener falls back to loopback and remote control turns off until the user picks an interface, so an
 * update never leaves either listening on whatever Wi-Fi the machine joins.
 */
export const pickInterface = (key: string, value: Record<string, unknown>, tailscale: string | null) => {
  if (!isWildcard(value["bindHost"])) return value
  if (key === "automations") return { ...value, bindHost: tailscale ?? "127.0.0.1" }
  return tailscale === null ? { ...value, enabled: false, bindHost: null } : { ...value, bindHost: tailscale }
}

const readSettings = (path: string) => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return Predicate.isObject(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Rewrites `settings.json` beside the database, where `27_settings_files` moved the settings. A file a hand edit broke
 * is left alone; the store reads it as defaults, which already means no listener on every interface.
 */
export const migrate = (tailscale: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [main] = yield* sql<{ readonly file: string }>`SELECT file FROM pragma_database_list WHERE name = 'main'`
    if (!main?.file) return
    const path = join(dirname(main.file), "settings.json")
    const settings = existsSync(path) ? readSettings(path) : null
    if (settings === null) return
    const next = { ...settings }
    for (const key of ["remote", "automations"]) {
      const value = settings[key]
      if (Predicate.isObject(value)) next[key] = pickInterface(key, value as Record<string, unknown>, tailscale)
    }
    if (next.remote === settings.remote && next.automations === settings.automations) return
    const temp = `${path}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temp, path)
  })

export default Effect.suspend(() => migrate(tailscaleAddress()))
