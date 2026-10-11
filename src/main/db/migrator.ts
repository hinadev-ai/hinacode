import { Effect } from "effect"
import { Migrator } from "effect/sql"
import init from "./migrations/0001_init.ts"
import automations from "./migrations/0002_automations.ts"

const run = Migrator.make({})

/** Keys are `<id>_<name>`; the id orders them. Append new migrations, never edit shipped ones. */
export const runMigrations = run({
  loader: Migrator.fromRecord({
    "1_init": init,
    "2_automations": automations,
  }),
}).pipe(Effect.tap((ran) => Effect.logInfo("migrations ran", ran)))
