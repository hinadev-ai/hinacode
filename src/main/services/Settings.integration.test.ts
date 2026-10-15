import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { defaultClientSettings, defaultSettings } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { ClientSettings, layer as clientLayer } from "./ClientSettings.ts"
import { Settings, layer } from "./Settings.ts"

const testLayer = Layer.mergeAll(layer, clientLayer).pipe(
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

describe("settings", () => {
  it.effect("fills the keys a stored object is missing from its defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO setting (key, value) VALUES ('archive', ${JSON.stringify({ whenMerged: true })})`
      yield* sql`INSERT INTO setting (key, value) VALUES ('notifications', ${JSON.stringify({ completed: false })})`
      const settings = yield* Settings.use((service) => service.get)
      expect(settings.archive).toEqual({ ...defaultSettings.archive, whenMerged: true })
      const client = yield* ClientSettings.use((service) => service.get)
      expect(client.notifications).toEqual({ ...defaultClientSettings.notifications, completed: false })
    }).pipe(Effect.provide(testLayer)),
  )
})
