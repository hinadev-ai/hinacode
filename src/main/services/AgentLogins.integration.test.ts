import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import type { AccountHome, AgentAccount } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { AgentAccounts, layer as accountsLayer } from "./AgentAccounts.ts"
import { AgentLogins, layer as loginsLayer } from "./AgentLogins.ts"
import { Settings, layer as settingsLayer } from "./Settings.ts"

const work: AgentAccount = { type: "subscription", email: "work@example.com", plan: "Claude Max", organization: null }

const fakeClaude = () => {
  const state = { answer: work as AgentAccount, calls: [] as Array<AccountHome | null> }
  const provider = (id: AgentProvider["id"]): AgentProvider => ({
    id,
    listModels: Effect.succeed([]),
    account: (home) =>
      Effect.sync(() => {
        state.calls.push(home)
        return state.answer
      }),
    planLimits: () => Effect.succeed(null),
    usage: () => Effect.succeed(null),
    listCommands: () => Effect.succeed([]),
    runTurn: () => Stream.empty,
    steer: () => Effect.void,
    interrupt: () => Effect.void,
    respondApproval: () => Effect.succeed(false),
    respondQuestion: () => Effect.void,
    setAccessMode: () => Effect.void,
  })
  const layer = Layer.mergeAll(
    Layer.succeed(ClaudeProvider, provider("claude")),
    Layer.succeed(CodexProvider, provider("codex")),
    Layer.succeed(MuseProvider, provider("muse")),
    Layer.succeed(OpencodeProvider, provider("opencode")),
    Layer.succeed(MagpieProvider, provider("magpie")),
  )
  return { state, layer }
}

const withLogins = <A, E>(
  effect: (
    cacheDir: string,
    claude: ReturnType<typeof fakeClaude>["state"],
  ) => Effect.Effect<A, E, AgentLogins | AgentAccounts | Settings>,
  dataDir = mkdtempSync(join(tmpdir(), "kk-logins-test-")),
) => {
  const cacheDir = join(dataDir, "cache")
  const claude = fakeClaude()
  const layer = loginsLayer(cacheDir).pipe(
    Layer.provideMerge(accountsLayer),
    Layer.provideMerge(settingsLayer(dataDir)),
    Layer.provide(claude.layer),
    Layer.provide(Db.layer(join(dataDir, "hinacode.db"))),
    Layer.provide(NodeServices.layer),
  )
  return effect(cacheDir, claude.state).pipe(Effect.provide(layer))
}

const createClaudeAccount = (name: string) =>
  AgentAccounts.use((accounts) =>
    accounts.create({ provider: "claude", name, configDir: "/tmp/kk-unused", binary: "claude" }),
  )

const cached = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { accountId: string | null }

describe("agent logins", () => {
  it.effect("answers a second read from the cache file without asking the CLI", () =>
    withLogins((cacheDir, claude) =>
      Effect.gen(function* () {
        const logins = yield* AgentLogins
        expect(yield* logins.account("claude", null)).toStrictEqual(work)
        claude.answer = { type: "apiKey" }

        expect(yield* logins.account("claude", null)).toStrictEqual(work)
        expect(claude.calls).toHaveLength(1)
        expect(cached(join(cacheDir, "default_claude.json"))).toMatchObject({ accountId: null, account: work })
      }),
    ),
  )

  it.effect("names the CLI's own login after its agent and an added account after its id", () =>
    withLogins((cacheDir) =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({
            defaultAccountName: {
              claude: "Mi cuenta personal!",
              codex: null,
              muse: null,
              opencode: null,
              magpie: null,
            },
          }),
        )
        const account = yield* AgentAccounts.use((accounts) =>
          accounts.create({
            provider: "claude",
            name: "  Work / Client  ",
            configDir: "/tmp/kk-unused",
            binary: "claude",
          }),
        )
        const logins = yield* AgentLogins
        yield* logins.account("claude", null)
        yield* logins.account("claude", account.id)

        expect(readdirSync(cacheDir).toSorted()).toStrictEqual([`${account.id}.json`, "default_claude.json"].toSorted())
      }),
    ),
  )

  it.effect("asks the CLI every time while it is signed out", () =>
    withLogins((cacheDir, claude) =>
      Effect.gen(function* () {
        claude.answer = { type: "signedOut" }
        const logins = yield* AgentLogins
        yield* logins.account("claude", null)
        claude.answer = work

        expect(yield* logins.account("claude", null)).toStrictEqual(work)
        expect(claude.calls).toHaveLength(2)
      }),
    ),
  )

  it.effect("on start, deletes caches an older version named after labels and keeps every login", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kk-logins-test-"))
    const cacheDir = join(dataDir, "cache")
    return Effect.gen(function* () {
      const account = yield* withLogins(() => createClaudeAccount("Default"), dataDir)
      mkdirSync(cacheDir, { recursive: true })
      const labelled = {
        "default_claude.json": account.id,
        "old-name_claude.json": account.id,
        "personal_codex.json": null,
        "removed_claude.json": "an-account-deleted-long-ago",
      }
      for (const [file, accountId] of Object.entries(labelled)) {
        writeFileSync(join(cacheDir, file), JSON.stringify({ accountId, account: work }))
      }

      yield* withLogins(
        (_, claude) =>
          Effect.gen(function* () {
            expect(readdirSync(cacheDir)).toStrictEqual(["default_claude.json"])
            const logins = yield* AgentLogins
            claude.answer = { type: "apiKey" }

            expect(yield* logins.account("claude", account.id)).toStrictEqual({ type: "apiKey" })
            expect(yield* logins.account("claude", null)).toStrictEqual({ type: "apiKey" })
            expect(claude.calls).toMatchObject([{ dir: "/tmp/kk-unused" }, null])
            expect(cached(join(cacheDir, "default_claude.json")).accountId).toBeNull()
            expect(readdirSync(cacheDir).toSorted()).toStrictEqual(
              [`${account.id}.json`, "default_claude.json"].toSorted(),
            )
          }),
        dataDir,
      )
    })
  })

  it.effect("caches two accounts whose names differ only in punctuation and case apart", () =>
    withLogins((_, claude) =>
      Effect.gen(function* () {
        const first = yield* createClaudeAccount("Work")
        const second = yield* createClaudeAccount("work!")
        const logins = yield* AgentLogins
        for (const id of [first.id, second.id, first.id, second.id]) yield* logins.account("claude", id)

        expect(claude.calls).toHaveLength(2)
      }),
    ),
  )

  it.effect("refuses an id that is not an account before touching the cache", () =>
    withLogins((cacheDir, claude) =>
      Effect.gen(function* () {
        const logins = yield* AgentLogins
        const error = yield* Effect.flip(logins.account("claude", "../escaped"))

        expect(error._tag).toBe("NotFoundError")
        expect(claude.calls).toHaveLength(0)
        expect(existsSync(join(cacheDir, "..", "escaped.json"))).toBe(false)
      }),
    ),
  )

  it.effect("asks the CLI again for a file it cannot read", () =>
    withLogins((cacheDir, claude) =>
      Effect.gen(function* () {
        const logins = yield* AgentLogins
        yield* logins.account("claude", null)
        writeFileSync(join(cacheDir, "default_claude.json"), '{"accountId":null,"account":{"type":"premium"}}')

        expect(yield* logins.account("claude", null)).toStrictEqual(work)
        expect(claude.calls).toHaveLength(2)
      }),
    ),
  )

  it.effect("refreshes from the CLI and rewrites the file, or drops it once signed out", () =>
    withLogins((cacheDir, claude) =>
      Effect.gen(function* () {
        const logins = yield* AgentLogins
        const path = join(cacheDir, "default_claude.json")
        yield* logins.account("claude", null)
        claude.answer = { type: "apiKey" }

        expect(yield* logins.account("claude", null, { refresh: true })).toStrictEqual({ type: "apiKey" })
        expect(cached(path)).toMatchObject({ account: { type: "apiKey" } })

        claude.answer = { type: "signedOut" }
        yield* logins.account("claude", null, { refresh: true })
        expect(existsSync(path)).toBe(false)
        expect(claude.calls).toHaveLength(3)
      }),
    ),
  )
})
