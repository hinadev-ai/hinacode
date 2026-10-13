import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as Db from "../db/client.ts"
import { AgentAccounts, layer as accountsLayer } from "./AgentAccounts.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import { Projects, layer as projectsLayer } from "./Projects.ts"
import { Settings, layer as settingsLayer } from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { Threads, layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

const testLayer = (root: string) =>
  threadsLayer.pipe(
    Layer.provide(Terminals.layer),
    Layer.provideMerge(Worktrees.layer),
    Layer.provideMerge(projectsLayer),
    Layer.provideMerge(accountsLayer(root)),
    Layer.provideMerge(settingsLayer),
    Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer, Layer.succeed(Events, { publish: () => Effect.void }))),
    Layer.provideMerge(Db.layer(":memory:")),
    Layer.provide(NodeServices.layer),
  )

const withServices = <A, E>(
  effect: (root: string) => Effect.Effect<A, E, Threads | AgentAccounts | Settings | Projects>,
) => {
  const root = mkdtempSync(join(tmpdir(), "kk-accounts-test-"))
  return effect(root).pipe(Effect.provide(testLayer(root)))
}

const newThread = Effect.gen(function* () {
  const project = yield* Projects.use((projects) =>
    projects.create({ name: "demo", rootPath: mkdtempSync(join(tmpdir(), "kk-accounts-project-")), setupScript: null }),
  )
  return yield* Threads.use((threads) =>
    threads.create({ projectId: project.id, title: "t", provider: "claude", model: "claude-sonnet-5-5" }),
  )
})

describe("agent accounts", () => {
  it.effect("lists created accounts and gives each its own home", () =>
    withServices((root) =>
      Effect.gen(function* () {
        const accounts = yield* AgentAccounts
        const work = yield* accounts.create({ provider: "claude", name: "Work" })
        const personal = yield* accounts.create({ provider: "codex", name: "Personal" })
        yield* accounts.rename(personal.id, "Home")

        expect(yield* accounts.list).toStrictEqual([work, { ...personal, name: "Home" }])
        const home = yield* accounts.home(work.id)
        expect(home).toBe(join(root, work.id))
        expect(existsSync(home!)).toBe(true)
        expect(yield* accounts.home(null)).toBeNull()
      }),
    ),
  )

  it.effect("starts a thread on the agent's default account and switches it with the agent", () =>
    withServices(() =>
      Effect.gen(function* () {
        const accounts = yield* AgentAccounts
        const claude = yield* accounts.create({ provider: "claude", name: "Work" })
        const codex = yield* accounts.create({ provider: "codex", name: "Work" })
        yield* Settings.use((settings) => settings.set({ defaultAccount: { claude: claude.id, codex: codex.id } }))

        const thread = yield* newThread
        expect(thread.accountId).toBe(claude.id)
        const switched = yield* Threads.use((threads) => threads.update({ id: thread.id, provider: "codex" }))
        expect(switched.accountId).toBe(codex.id)
        expect((yield* Threads.use((threads) => threads.get(thread.id))).accountId).toBe(codex.id)
      }),
    ),
  )

  it.effect("refuses an account of another agent", () =>
    withServices(() =>
      Effect.gen(function* () {
        const codex = yield* AgentAccounts.use((accounts) => accounts.create({ provider: "codex", name: "Work" }))
        const thread = yield* newThread
        const error = yield* Threads.use((threads) => threads.update({ id: thread.id, accountId: codex.id })).pipe(
          Effect.flip,
        )
        expect(error._tag).toBe("NotFoundError")
      }),
    ),
  )

  it.effect("fixes the account once the thread has a provider session", () =>
    withServices(() =>
      Effect.gen(function* () {
        const accounts = yield* AgentAccounts
        const work = yield* accounts.create({ provider: "claude", name: "Work" })
        const thread = yield* newThread
        const threads = yield* Threads
        expect((yield* threads.update({ id: thread.id, accountId: work.id })).accountId).toBe(work.id)
        yield* threads.update({ id: thread.id, providerSessionId: "session" })

        const error = yield* threads.update({ id: thread.id, accountId: null }).pipe(Effect.flip)
        expect(error._tag).toBe("ThreadStartedError")
        expect((yield* threads.update({ id: thread.id, accountId: work.id, title: "same account" })).title).toBe(
          "same account",
        )
      }),
    ),
  )

  it.effect("refuses to remove an account a thread uses, then removes it with its home and default", () =>
    withServices(() =>
      Effect.gen(function* () {
        const accounts = yield* AgentAccounts
        const work = yield* accounts.create({ provider: "claude", name: "Work" })
        yield* Settings.use((settings) => settings.set({ defaultAccount: { claude: work.id, codex: null } }))
        const home = (yield* accounts.home(work.id))!
        const thread = yield* newThread
        const signedOut: Array<string> = []
        const signOut = (_: unknown, path: string) => Effect.sync(() => void signedOut.push(path))

        const refused = yield* accounts.remove(work.id, signOut).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "AccountInUseError", threads: 1 })
        expect(signedOut).toStrictEqual([])
        expect(yield* accounts.list).toHaveLength(1)

        yield* Threads.use((threads) => threads.remove(thread.id))
        yield* accounts.remove(work.id, signOut)
        expect(signedOut).toStrictEqual([home])
        expect(existsSync(home)).toBe(false)
        expect(yield* accounts.list).toStrictEqual([])
        expect((yield* Settings.use((settings) => settings.get)).defaultAccount.claude).toBeNull()
      }),
    ),
  )
})
