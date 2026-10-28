import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import type { AccountHome, AgentAccount } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { AgentAccounts, layer as accountsLayer } from "./AgentAccounts.ts"
import { AgentLogins, layer as loginsLayer } from "./AgentLogins.ts"
import { Settings, layer as settingsLayer } from "./Settings.ts"

const work: AgentAccount = { type: "subscription", email: "work@example.com", plan: "Claude Max", organization: null }

/** A Claude whose answer the test sets, counting every time it is asked. */
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
    respondApproval: () => Effect.void,
    respondQuestion: () => Effect.void,
    setAccessMode: () => Effect.void,
  })
  const layer = Layer.mergeAll(
    Layer.succeed(ClaudeProvider, provider("claude")),
    Layer.succeed(CodexProvider, provider("codex")),
    Layer.succeed(MuseProvider, provider("muse")),
  )
  return { state, layer }
}

const withLogins = <A, E>(
  effect: (
    cacheDir: string,
    claude: ReturnType<typeof fakeClaude>["state"],
  ) => Effect.Effect<A, E, AgentLogins | AgentAccounts | Settings>,
) => {
  const cacheDir = join(mkdtempSync(join(tmpdir(), "kk-logins-test-")), "cache")
  const claude = fakeClaude()
  const layer = loginsLayer(cacheDir).pipe(
    Layer.provideMerge(accountsLayer),
    Layer.provideMerge(settingsLayer),
    Layer.provide(claude.layer),
    Layer.provide(Db.layer(":memory:")),
    Layer.provide(NodeServices.layer),
  )
  return effect(cacheDir, claude.state).pipe(Effect.provide(layer))
}

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

  it.effect("labels the CLI's own login with its name and an added account with the account's", () =>
    withLogins((cacheDir) =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({ defaultAccountName: { claude: "Mi cuenta personal!", codex: null, muse: null } }),
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

        expect(readdirSync(cacheDir).toSorted()).toStrictEqual([
          "mi-cuenta-personal_claude.json",
          "work-client_claude.json",
        ])
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

  it.effect("ignores a file left by another account under the same label", () =>
    withLogins((cacheDir, claude) =>
      Effect.gen(function* () {
        const logins = yield* AgentLogins
        yield* logins.account("claude", null)
        const account = yield* AgentAccounts.use((accounts) =>
          accounts.create({ provider: "claude", name: "Default", configDir: "/tmp/kk-unused", binary: "claude" }),
        )
        claude.answer = { type: "apiKey" }

        expect(yield* logins.account("claude", account.id)).toStrictEqual({ type: "apiKey" })
        expect(claude.calls).toHaveLength(2)
        expect(cached(join(cacheDir, "default_claude.json")).accountId).toBe(account.id)
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
