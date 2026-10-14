import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { type AccountHome, AccountProviderId, AgentProfile } from "../../shared/agent.ts"
import { nowIso } from "./clock.ts"
import { AccountInUseError, NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import { Settings } from "./Settings.ts"

/**
 * Accounts added in kkcode. Each one is an agent home the user picked (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`),
 * which holds its login and its transcripts, and the CLI binary run against it. The user signs it in from a
 * terminal. A null account id is the CLI's own login and default home.
 */
export class AgentAccounts extends Context.Service<
  AgentAccounts,
  {
    readonly list: Effect.Effect<ReadonlyArray<AgentProfile>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<AgentProfile, PersistenceError | NotFoundError>
    /** `configDir` may start with `~`; it is stored expanded and absolute. */
    readonly create: (input: CreateAccount) => Effect.Effect<AgentProfile, PersistenceError>
    readonly rename: (id: string, name: string) => Effect.Effect<AgentProfile, PersistenceError | NotFoundError>
    /**
     * Refused while any thread points at the account. The row and the account's place as a default go away;
     * its config directory stays on disk.
     */
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError | NotFoundError | AccountInUseError>
    /** The account's home and binary. Null for the CLI's own login. */
    readonly home: (id: string | null) => Effect.Effect<AccountHome | null, PersistenceError | NotFoundError>
  }
>()("kkcode/AgentAccounts") {}

interface CreateAccount {
  readonly provider: AccountProviderId
  readonly name: string
  readonly configDir: string
  readonly binary: string
}

const expandHome = (path: string) =>
  resolve(path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const settings = yield* Settings

  // Like the thread list, a newer build's accounts of unknown providers are skipped, not fatal.
  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AgentProfile,
    execute: () =>
      sql`SELECT id, provider, name, config_dir, binary FROM agent_account WHERE ${sql.in("provider", [...AccountProviderId.literals])} ORDER BY created_at, rowid`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AgentProfile,
    execute: (id) => sql`SELECT id, provider, name, config_dir, binary FROM agent_account WHERE id = ${id}`,
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

  const create = (input: CreateAccount) =>
    Effect.gen(function* () {
      const account: AgentProfile = {
        id: randomUUID(),
        provider: input.provider,
        name: input.name,
        configDir: expandHome(input.configDir),
        binary: input.binary,
      }
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

  const remove = (id: string) =>
    Effect.gen(function* () {
      const account = yield* get(id)
      const { threads } = yield* countThreads(id).pipe(Effect.mapError(persistence("accounts.remove")))
      if (threads > 0) return yield* new AccountInUseError({ id, threads })
      yield* sql`DELETE FROM agent_account WHERE id = ${id}`.pipe(Effect.mapError(persistence("accounts.remove")))
      const { defaultAccount } = yield* settings.get
      if (defaultAccount[account.provider] === id) {
        yield* settings.set({ defaultAccount: { ...defaultAccount, [account.provider]: null } })
      }
    })

  const home = (id: string | null) =>
    Effect.gen(function* () {
      if (id === null) return null
      const { configDir, binary } = yield* get(id)
      return { dir: configDir, binary } satisfies AccountHome
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

export const layer = Layer.effect(AgentAccounts, make)
