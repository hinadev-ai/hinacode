import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../db/client.ts"
import * as SecretsModule from "./Secrets.ts"
import { Secrets } from "./Secrets.ts"

const testLayer = SecretsModule.layer.pipe(
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(Layer.mergeAll(NodeServices.layer, SecretsModule.noKeyring)),
)

describe("Secrets", () => {
  it.effect("reads a secret sealed under another key as unset, and saves it again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sealed = JSON.stringify({ encrypted: true, value: Buffer.from("other key").toString("base64") })
      yield* sql`INSERT INTO setting (key, value) VALUES ('secret.remote.token', ${sealed})`
      const secrets = yield* Secrets

      expect(yield* secrets.get("remote.token")).toStrictEqual(Option.none())
      yield* secrets.set("remote.token", "fresh")
      expect(yield* secrets.get("remote.token")).toStrictEqual(Option.some("fresh"))
    }).pipe(Effect.provide(testLayer)),
  )
})
