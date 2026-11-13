import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { RemoteAccess } from "../../remote/access.ts"
import { Settings } from "../Settings.ts"
import { callHub } from "./hub.ts"

const CLAIM_EVERY = "5 seconds"
const CLAIM_TIMEOUT = "10 seconds"

export const hubClaimsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const settings = yield* Settings
    const { identity } = yield* RemoteAccess
    const client = { id: identity.id, name: identity.name }
    const left = new Set<string>()
    let current: string | undefined

    const claim = (hub: string, threads: ReadonlyArray<{ id: string; title: string | null }>) =>
      callHub(hub, "devices.claim", { client, threads }).pipe(Effect.timeout(CLAIM_TIMEOUT))

    const tick = Effect.gen(function* () {
      const { experimental } = yield* settings.get
      if (!experimental.devices) return
      const hub = experimental.devicesOn ?? undefined
      if (current !== undefined && current !== hub) left.add(current)
      current = hub
      if (hub !== undefined) left.delete(hub)
      for (const leftHub of left) {
        yield* claim(leftHub, []).pipe(Effect.andThen(Effect.sync(() => left.delete(leftHub))), Effect.ignore)
      }
      if (hub === undefined) return
      const threads = yield* sql<{ id: string; title: string | null }>`
        SELECT id, title FROM thread WHERE status != 'archived'
      `
      yield* claim(hub, threads).pipe(Effect.ignore)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("device hub claim failed", cause)))

    yield* tick.pipe(Effect.schedule(Schedule.spaced(CLAIM_EVERY)), Effect.forkScoped)
  }),
)
