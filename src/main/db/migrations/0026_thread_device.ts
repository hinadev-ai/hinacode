import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // No foreign key: a deleted thread's rows outlive it until the Devices sweep deletes the simulators they own.
  yield* sql`
    CREATE TABLE thread_device (
      thread_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      owned INTEGER NOT NULL,
      PRIMARY KEY (thread_id, device_id)
    )
  `
})
