import { Effect } from "effect"
import { Migrator } from "effect/sql"
import init from "./migrations/0001_init.ts"
import automations from "./migrations/0002_automations.ts"
import threadEffort from "./migrations/0004_thread_effort.ts"
import threadAccessMode from "./migrations/0005_thread_access_mode.ts"
import messagesFts from "./migrations/0008_messages_fts.ts"
import turnBaseTree from "./migrations/0007_turn_base_tree.ts"
import threadLimited from "./migrations/0006_thread_limited.ts"
import archive from "./migrations/0009_archive.ts"
import agentAccounts from "./migrations/0010_agent_accounts.ts"
import museProvider from "./migrations/0011_muse_provider.ts"
import accountHome from "./migrations/0012_account_home.ts"

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
    "6_thread_limited": threadLimited,
    "7_turn_base_tree": turnBaseTree,
    "8_messages_fts": messagesFts,
    "9_archive": archive,
    "10_agent_accounts": agentAccounts,
    "11_muse_provider": museProvider,
    "12_account_home": accountHome,
  }),
}).pipe(Effect.tap((ran) => Effect.logInfo("migrations ran", ran)))
