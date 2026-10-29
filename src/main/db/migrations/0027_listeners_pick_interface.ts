import { Effect } from "effect"
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

export const migrate = (tailscale: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ key: string; value: string }>`
      SELECT key, value FROM setting WHERE key IN ('remote', 'automations')
    `
    for (const row of rows) {
      const value = JSON.parse(row.value) as Record<string, unknown>
      const next = pickInterface(row.key, value, tailscale)
      if (next !== value) yield* sql`UPDATE setting SET value = ${JSON.stringify(next)} WHERE key = ${row.key}`
    }
  })

export default Effect.suspend(() => migrate(tailscaleAddress()))
