import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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

const testLayer = threadsLayer.pipe(
  Layer.provide(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(projectsLayer),
  Layer.provideMerge(accountsLayer),
  Layer.provideMerge(settingsLayer),
  Layer.provide(
    Layer.mergeAll(Git.layer, GitHub.layer).pipe(
      Layer.provideMerge(Layer.succeed(Events, { publish: () => Effect.void })),
    ),
  ),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const withServices = <A, E>(
  effect: (root: string) => Effect.Effect<A, E, Threads | AgentAccounts | Settings | Projects>,
) => {
  const root = mkdtempSync(join(tmpdir(), "kk-accounts-test-"))
  return effect(root).pipe(Effect.provide(testLayer))
}

const newAccount = (provider: "claude" | "codex", name: string, configDir = "/tmp/kk-accounts-unused") => ({
  provider,
  name,
  configDir,
  binary: provider,
})

const newThread = Effect.gen(function* () {
  const project = yield* Projects.use((projects) =>
    projects.create({ name: "demo", rootPath: mkdtempSync(join(tmpdir(), "kk-accounts-project-")), setupScript: null }),
  )
  return yield* Threads.use((threads) =>
    threads.create({ projectId: project.id, title: "t", provider: "claude", model: "claude-sonnet-5-5" }),
  )
})

describe("agent accounts", () => {
  it.effect("lists created accounts with the home and binary each was given", () =>
    withServices((root) =>
      Effect.gen(function* () {
        const accounts = yield* AgentAccounts
        const work = yield* accounts.create({
          provider: "claude",
          name: "Work",
          configDir: join(root, "nested", "..", "work"),
          binary: "/opt/bin/claude",
        })
        const personal = yield* accounts.create({
          provider: "codex",
          name: "Personal",
          configDir: "~/.codex-personal",
          binary: "codex",
        })
        yield* accounts.rename(personal.id, "Home")

        expect(personal.configDir).toBe(join(homedir(), ".codex-personal"))
        expect(yield* accounts.list).toStrictEqual([work, { ...personal, name: "Home" }])
        expect(yield* accounts.home(work.id)).toStrictEqual({ dir: join(root, "work"), binary: "/opt/bin/claude" })
        expect(yield* accounts.home(null)).toBeNull()
        expect(existsSync(join(root, "work"))).toBe(false)
      }),
    ),
  )

  it.effect("starts a thread on the agent's default account and switches it with the agent", () =>
    withServices(() =>
      Effect.gen(function* () {
        const accounts = yield* AgentAccounts
        const claude = yield* accounts.create(newAccount("claude", "Work"))
        const codex = yield* accounts.create(newAccount("codex", "Work"))
        yield* Settings.use((settings) =>
          settings.set({ defaultAccount: { claude: claude.id, codex: codex.id, muse: null } }),
        )

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
        const codex = yield* AgentAccounts.use((accounts) => accounts.create(newAccount("codex", "Work")))
        const thread = yield* newThread
        const error = yield* Threads.use((threads) => threads.update({ id: thread.id, accountId: codex.id })).pipe(
          Effect.flip,
        )
        expect(error._tag).toBe("NotFoundError")
      }),
    ),
  )

  it.effect("refuses to remove an account a thread uses, then removes it and its default but keeps its home", () =>
    withServices((root) =>
      Effect.gen(function* () {
        const accounts = yield* AgentAccounts
        const home = join(root, "work")
        mkdirSync(home)
        const work = yield* accounts.create(newAccount("claude", "Work", home))
        yield* Settings.use((settings) =>
          settings.set({ defaultAccount: { claude: work.id, codex: null, muse: null } }),
        )
        const thread = yield* newThread

        const refused = yield* accounts.remove(work.id).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "AccountInUseError", threads: 1 })
        expect(yield* accounts.list).toHaveLength(1)

        yield* Threads.use((threads) => threads.remove(thread.id))
        yield* accounts.remove(work.id)
        expect(existsSync(home)).toBe(true)
        expect(yield* accounts.list).toStrictEqual([])
        expect((yield* Settings.use((settings) => settings.get)).defaultAccount.claude).toBeNull()
      }),
    ),
  )
})
