import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentAccount, type AgentProfile, ProviderId } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import type { AgentError, AgentProvider } from "../agents/provider.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import type { NotFoundError, PersistenceError } from "./errors.ts"

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
  }),
)
const decodeCached = Schema.decodeUnknownEffect(CachedAccount)
const encodeCached = Schema.encodeEffect(CachedAccount)

const defaultFile = (provider: ProviderId) => `default_${provider}.json`
const accountFile = (accountId: string) => `${accountId}.json`

const readCached = (path: string, accountId: string | null) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap(decodeCached),
    Effect.option,
    Effect.map(Option.filter((cached) => cached.accountId === accountId)),
  )

const remove = (path: string) => Effect.tryPromise(() => rm(path, { force: true })).pipe(Effect.ignore)

const writeCached = (path: string, accountId: string | null, account: AgentAccount) =>
  Effect.gen(function* () {
    const content = yield* encodeCached({ accountId, account })
    const temp = `${path}.${process.pid}.tmp`
    yield* Effect.tryPromise(async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, content)
      await rename(temp, path)
    })
  }).pipe(Effect.catch((cause) => Effect.logWarning("Could not cache the account", path, cause)))

const removeAllBut = (cacheDir: string, profiles: ReadonlyArray<AgentProfile>) =>
  Effect.gen(function* () {
    const live = new Set([
      ...ProviderId.literals.map(defaultFile),
      ...profiles.map((profile) => accountFile(profile.id)),
    ])
    const files = yield* Effect.tryPromise(() => readdir(cacheDir))
    const stale = files.filter((name) => name.endsWith(".json") && !live.has(name))
    yield* Effect.forEach(stale, (name) => remove(join(cacheDir, name)))
  })

const make = (cacheDir: string) =>
  Effect.gen(function* () {
    const accounts = yield* AgentAccounts
    const providers: Record<ProviderId, AgentProvider> = {
      claude: yield* ClaudeProvider,
      codex: yield* CodexProvider,
      muse: yield* MuseProvider,
      opencode: yield* OpencodeProvider,
      magpie: yield* MagpieProvider,
    }

    yield* accounts.list.pipe(
      Effect.flatMap((profiles) => removeAllBut(cacheDir, profiles)),
      Effect.ignore,
    )

    const fetch = (provider: ProviderId, accountId: string | null) =>
      Effect.gen(function* () {
        if (accountId === null) return yield* providers[provider].account(null)
        const account = yield* accounts.get(accountId)
        return yield* providers[account.provider].account(yield* accounts.home(accountId))
      })

    const cachePath = (provider: ProviderId, accountId: string | null) =>
      accountId === null
        ? Effect.succeed(join(cacheDir, defaultFile(provider)))
        : Effect.map(accounts.get(accountId), (profile) => join(cacheDir, accountFile(profile.id)))

    const account = (provider: ProviderId, accountId: string | null, options?: { readonly refresh?: boolean }) =>
      Effect.gen(function* () {
        const path = yield* cachePath(provider, accountId)
        const cached = yield* readCached(path, accountId)
        if (Option.isSome(cached) && !options?.refresh) return cached.value.account
        const fresh = yield* fetch(provider, accountId)
        if (fresh.type !== "signedOut") yield* writeCached(path, accountId, fresh)
        else yield* remove(path)
        return fresh
      })

    return AgentLogins.of({ account, forget: (accountId) => remove(join(cacheDir, accountFile(accountId))) })
  })

export const layer = (cacheDir: string) => Layer.effect(AgentLogins, make(cacheDir))
