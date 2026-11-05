import { Effect, Layer } from "effect"
import * as Db from "../../src/main/db/client.ts"
await Effect.runPromise(Layer.build(Db.layer("/tmp/kk-probe.sqlite")).pipe(Effect.scoped))
console.log("migrated")
