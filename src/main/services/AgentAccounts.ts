import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { AgentProfile, ProviderId } from "../../shared/agent.ts"
import { nowIso } from "./clock.ts"
import { AccountInUseError, NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import { Settings } from "./Settings.ts"

/**
 * Accounts added in kkcode. Each one is an agent home under `root` (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`),
 * which holds its login and its transcripts. A null account id is the CLI's own login and default home.
 */
export class AgentAccounts extends Context.Service<
  AgentAccounts,
  {
    readonly list: Effect.Effect<ReadonlyArray<AgentProfile>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<AgentProfile, PersistenceError | NotFoundError>
    readonly create: (input: {
      readonly provider: ProviderId
      readonly name: string
    }) => Effect.Effect<AgentProfile, PersistenceError>
    readonly rename: (id: string, name: string) => Effect.Effect<AgentProfile, PersistenceError | NotFoundError>
    /**
     * Refused while any thread points at the account. `signOut` runs first, while the home still exists;
     * then the row, the home and the account's place as a default go away.
     */
    readonly remove: (
      id: string,
      signOut: (account: AgentProfile, home: string) => Effect.Effect<void>,
    ) => Effect.Effect<void, PersistenceError | NotFoundError | AccountInUseError>
    /** The account's home, created on first use. Null for the CLI's own login. */
    readonly home: (id: string | null) => Effect.Effect<string | null, PersistenceError | NotFoundError>
  }
>()("kkcode/AgentAccounts") {}

const make = (root: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const fs = yield* FileSystem.FileSystem
    const settings = yield* Settings

    // Like the thread list, a newer build's accounts of unknown providers are skipped, not fatal.
    const findAll = SqlSchema.findAll({
      Request: Schema.Void,
      Result: AgentProfile,
      execute: () =>
        sql`SELECT id, provider, name FROM agent_account WHERE ${sql.in("provider", [...ProviderId.literals])} ORDER BY created_at, rowid`,
    })
    const findById = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: AgentProfile,
      execute: (id) => sql`SELECT id, provider, name FROM agent_account WHERE id = ${id}`,
    })
    const countThreads = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ threads: Schema.Number }),
      execute: (id) => sql`SELECT COUNT(*) AS threads FROM thread WHERE account_id = ${id}`,
    })

    const get = (id: string) =>
      findById(id).pipe(
        Effect.mapError(persistence("accounts.get")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFoundError({ entity: "account", id })),
            onSome: Effect.succeed,
          }),
        ),
      )

    const create = (input: { readonly provider: ProviderId; readonly name: string }) =>
      Effect.gen(function* () {
        const account: AgentProfile = { id: randomUUID(), provider: input.provider, name: input.name }
        const createdAt = yield* nowIso
        yield* sql`INSERT INTO agent_account ${sql.insert({ ...account, createdAt })}`.pipe(
          Effect.mapError(persistence("accounts.create")),
        )
        return account
      })

    const rename = (id: string, name: string) =>
      Effect.gen(function* () {
        const account = yield* get(id)
        yield* sql`UPDATE agent_account SET name = ${name} WHERE id = ${id}`.pipe(
          Effect.mapError(persistence("accounts.rename")),
        )
        return { ...account, name }
      })

    const remove = (id: string, signOut: (account: AgentProfile, home: string) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        const account = yield* get(id)
        const { threads } = yield* countThreads(id).pipe(Effect.mapError(persistence("accounts.remove")))
        if (threads > 0) return yield* new AccountInUseError({ id, threads })
        const home = join(root, id)
        if (yield* fs.exists(home).pipe(Effect.orElseSucceed(() => false))) yield* signOut(account, home)
        yield* sql`DELETE FROM agent_account WHERE id = ${id}`.pipe(Effect.mapError(persistence("accounts.remove")))
        yield* fs
          .remove(home, { recursive: true, force: true })
          .pipe(Effect.catch((error) => Effect.logWarning("could not delete the account home", error)))
        const { defaultAccount } = yield* settings.get
        if (defaultAccount[account.provider] === id) {
          yield* settings.set({ defaultAccount: { ...defaultAccount, [account.provider]: null } })
        }
      })

    const home = (id: string | null) =>
      Effect.gen(function* () {
        if (id === null) return null
        yield* get(id)
        const path = join(root, id)
        yield* fs.makeDirectory(path, { recursive: true }).pipe(Effect.orDie)
        return path
      })

    return AgentAccounts.of({
      list: findAll(undefined).pipe(Effect.mapError(persistence("accounts.list"))),
      get,
      create,
      rename,
      remove,
      home,
    })
  })

/** `root` holds one home directory per account, named by its id. */
export const layer = (root: string) => Layer.effect(AgentAccounts, make(root))
