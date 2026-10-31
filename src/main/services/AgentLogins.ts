import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentAccount, type ProviderId } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { CursorProvider } from "../agents/cursor/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import type { AgentError, AgentProvider } from "../agents/provider.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import { nowIso } from "./clock.ts"
import type { NotFoundError, PersistenceError } from "./errors.ts"
import { Settings } from "./Settings.ts"

export class AgentLogins extends Context.Service<
  AgentLogins,
  {
    readonly account: (
      provider: ProviderId,
      accountId: string | null,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<AgentAccount, AgentError | PersistenceError | NotFoundError>
    readonly forget: (accountId: string) => Effect.Effect<void>
  }
>()("hinacode/AgentLogins") {}

const CachedAccount = Schema.fromJsonString(
  Schema.Struct({
    accountId: Schema.NullOr(Schema.String),
    account: AgentAccount,
    fetchedAt: Schema.String,
  }),
)
const decodeCached = Schema.decodeUnknownEffect(CachedAccount)
const encodeCached = Schema.encodeEffect(CachedAccount)

const slugify = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "account"

const readCached = (path: string, accountId: string | null) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap(decodeCached),
    Effect.option,
    Effect.map(Option.filter((cached) => cached.accountId === accountId)),
  )

const remove = (path: string) => Effect.tryPromise(() => rm(path, { force: true })).pipe(Effect.ignore)

const writeCached = (path: string, accountId: string | null, account: AgentAccount) =>
  Effect.gen(function* () {
    const content = yield* encodeCached({ accountId, account, fetchedAt: yield* nowIso })
    const temp = `${path}.${process.pid}.tmp`
    yield* Effect.tryPromise(async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, content)
      await rename(temp, path)
    })
  }).pipe(Effect.catch((cause) => Effect.logWarning("Could not cache the account", path, cause)))

const forgetIn = (cacheDir: string, accountId: string) =>
  Effect.gen(function* () {
    const files = yield* Effect.tryPromise(() => readdir(cacheDir)).pipe(Effect.orElseSucceed(() => []))
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const path = join(cacheDir, file)
      if (Option.isSome(yield* readCached(path, accountId))) yield* remove(path)
    }
  })

const make = (cacheDir: string) =>
  Effect.gen(function* () {
    const accounts = yield* AgentAccounts
    const settings = yield* Settings
    const providers: Record<ProviderId, AgentProvider> = {
      claude: yield* ClaudeProvider,
      codex: yield* CodexProvider,
      muse: yield* MuseProvider,
      cursor: yield* CursorProvider,
      opencode: yield* OpencodeProvider,
    }

    const fetch = (provider: ProviderId, accountId: string | null) =>
      Effect.gen(function* () {
        if (accountId === null) return yield* providers[provider].account(null)
        const account = yield* accounts.get(accountId)
        return yield* providers[account.provider].account(yield* accounts.home(accountId))
      })

    const cachePath = (provider: ProviderId, accountId: string | null) =>
      Effect.gen(function* () {
        const label =
          accountId === null
            ? ((yield* settings.get).defaultAccountName[provider] ?? "default")
            : (yield* accounts.get(accountId)).name
        return join(cacheDir, `${slugify(label)}_${provider}.json`)
      })

    const account = (provider: ProviderId, accountId: string | null, options?: { readonly refresh?: boolean }) =>
      Effect.gen(function* () {
        const path = yield* cachePath(provider, accountId)
        const cached = yield* readCached(path, accountId)
        if (Option.isSome(cached) && !options?.refresh) return cached.value.account
        const fresh = yield* fetch(provider, accountId)
        if (fresh.type !== "signedOut") yield* writeCached(path, accountId, fresh)
        else if (Option.isSome(cached)) yield* remove(path)
        return fresh
      })

    return AgentLogins.of({ account, forget: (accountId) => forgetIn(cacheDir, accountId) })
  })

export const layer = (cacheDir: string) => Layer.effect(AgentLogins, make(cacheDir))
