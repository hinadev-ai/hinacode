import { Effect } from "effect"
import { Migrator } from "effect/sql"
import init from "./migrations/0001_init.ts"
import automations from "./migrations/0002_automations.ts"
import threadEffort from "./migrations/0004_thread_effort.ts"
import threadAccessMode from "./migrations/0005_thread_access_mode.ts"
import messagesFts from "./migrations/0006_messages_fts.ts"

const run = Migrator.make({})

/**
 * Keys are `<id>_<name>`; the id orders them. Append new migrations, never edit shipped ones.
 * Id 3 belonged to a removed migration that some databases already recorded, so the next one is 4.
 */
export const runMigrations = run({
  loader: Migrator.fromRecord({
    "1_init": init,
    "2_automations": automations,
    "4_thread_effort": threadEffort,
    "5_thread_access_mode": threadAccessMode,
    "6_messages_fts": messagesFts,
  }),
}).pipe(Effect.tap((ran) => Effect.logInfo("migrations ran", ran)))
