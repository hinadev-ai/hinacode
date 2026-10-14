import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Stream } from "effect"
import { vi } from "vitest"
import type { ProviderId, RunTurnInput } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { McpCredentials } from "../mcp/credentials.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { AgentRunner, layer } from "./AgentRunner.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import * as Messages from "./Messages.ts"
import * as Projects from "./Projects.ts"
import * as PullRequests from "./PullRequests.ts"
import { Secrets } from "./Secrets.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { ThreadNaming } from "./ThreadNaming.ts"
import * as Threads from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

interface Probe {
  readonly runner: AgentRunner["Service"]
  readonly threads: Threads.Threads["Service"]
  readonly worktrees: Worktrees.Worktrees["Service"]
  readonly accounts: AgentAccounts.AgentAccounts["Service"]
  readonly root: string
  readonly thread: Thread
  readonly waiting: Promise<void>
  readonly prepared: Promise<void>
  readonly inserting: Promise<void>
  readonly idle: Promise<void>
  readonly turns: Array<{ readonly provider: ProviderId; readonly input: RunTurnInput }>
  readonly release: () => void
  readonly deliver: () => void
}

const withPreparingThread = async (run: (probe: Probe) => Promise<void>, pauseInsertion = false) => {
  const dir = mkdtempSync(join(tmpdir(), "kk-runner-preparation-"))
  const root = join(dir, "repo")
  execFileSync("git", ["init", "-q", "-b", "main", root])
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ])
  const release = () => writeFileSync(join(root, "release"), "")
  const started = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const prepared = Promise.withResolvers<void>()
  const inserting = Promise.withResolvers<void>()
  const inserted = Promise.withResolvers<void>()
  const idle = Promise.withResolvers<void>()
  const deliver = () => inserted.resolve()
  let holdInsertion = pauseInsertion
  const turns: Probe["turns"] = []
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provide(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer),
    ),
    Messages.layer,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Git.layer,
        GitHub.layer,
        Layer.succeed(Events, {
          publish: (event) =>
            Effect.sync(() => {
              if (event.type === "worktree.setupLog" && event.chunk.includes("setup started")) started.resolve()
              if (event.type === "thread.updated" && event.thread.status === "idle") idle.resolve()
            }),
        }),
      ),
    ),
    Layer.provideMerge(Db.layer(join(dir, "kkcode.sqlite"))),
    Layer.provide(NodeServices.layer),
  )
  const domainRuntime = ManagedRuntime.make(domain)
  const provider = (id: ProviderId): AgentProvider => ({
    id,
    listModels: Effect.succeed([]),
    account: () => Effect.succeed({ type: "apiKey" }),
    planLimits: () => Effect.succeed(null),
    usage: () => Effect.succeed(null),
    listCommands: () => Effect.succeed([]),
    runTurn: (input) =>
      Stream.suspend(() => {
        turns.push({ provider: id, input })
        return Stream.never
      }),
    steer: () => Effect.void,
    interrupt: () => Effect.void,
    setAccessMode: () => Effect.void,
    respondApproval: () => Effect.void,
    respondQuestion: () => Effect.void,
  })
  try {
    const project = await domainRuntime.runPromise(
      Projects.Projects.use((projects) =>
        projects.create({
          name: "repo",
          rootPath: root,
          setupScript: [
            'printf "setup started\\n"',
            'while [ ! -f "$KKCODE_ROOT_PATH/release" ]; do sleep 0.02; done',
          ].join("\n"),
        }),
      ),
    )
    const thread = await domainRuntime.runPromise(
      Threads.Threads.use((threads) =>
        threads.create({
          projectId: project.id,
          title: "Pending",
          provider: "claude",
          model: "initial-model",
          createdBy: "automation",
          worktree: { branch: "fix/pending", baseRef: "main" },
        }),
      ),
    )
    await started.promise
    const context = await domainRuntime.context()
    const worktrees = Context.get(context, Worktrees.Worktrees)
    const messages = Context.get(context, Messages.Messages)
    const runnerRuntime = ManagedRuntime.make(
      layer.pipe(
        Layer.provide(PullRequests.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ClaudeProvider, provider("claude")),
            Layer.succeed(CodexProvider, provider("codex")),
            Layer.succeed(MuseProvider, provider("muse")),
            Layer.succeed(Secrets, {
              get: () => Effect.succeed(Option.none()),
              has: () => Effect.succeed(false),
              set: () => Effect.void,
              clear: () => Effect.void,
            }),
            Layer.succeed(McpCredentials, {
              connectionFor: () =>
                Effect.succeed({ url: "http://127.0.0.1:1", headers: { authorization: "Bearer test" } }),
              authenticate: () => Option.none(),
              listening: () => Effect.void,
            }),
            Layer.succeed(ThreadNaming, { nameFromPrompt: () => Effect.void }),
            Layer.succeed(Messages.Messages, {
              ...messages,
              insert: (message) =>
                Effect.gen(function* () {
                  if (holdInsertion && message.role === "user") {
                    holdInsertion = false
                    inserting.resolve()
                    yield* Effect.promise(() => inserted.promise)
                  }
                  yield* messages.insert(message)
                }),
            }),
            Layer.succeed(Worktrees.Worktrees, {
              ...worktrees,
              whenPrepared: (id) =>
                Effect.sync(() => waiting.resolve()).pipe(
                  Effect.andThen(worktrees.whenPrepared(id)),
                  Effect.tap(() => Effect.sync(() => prepared.resolve())),
                ),
            }),
          ),
        ),
        Layer.provideMerge(Layer.succeedContext(context)),
      ),
    )
    try {
      await run({
        runner: await runnerRuntime.runPromise(AgentRunner),
        threads: Context.get(context, Threads.Threads),
        worktrees,
        accounts: Context.get(context, AgentAccounts.AgentAccounts),
        root,
        thread,
        waiting: waiting.promise,
        prepared: prepared.promise,
        inserting: inserting.promise,
        idle: idle.promise,
        turns,
        release,
        deliver,
      })
    } finally {
      deliver()
      release()
      await domainRuntime.runPromise(worktrees.whenPrepared(thread.worktreeId!))
      await runnerRuntime.dispose()
    }
  } finally {
    release()
    await domainRuntime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

it("keeps the transcript readable while a first send waits for setup", async () => {
  await withPreparingThread(async ({ runner, thread, waiting, release }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "wait for setup", []))
    await waiting
    const read = Effect.runFork(runner.transcript(thread.id))
    try {
      await Effect.runPromise(Effect.yieldNow)
      expect(read.pollUnsafe()).toBeDefined()
      expect((await Effect.runPromise(Fiber.join(read))).messages).toStrictEqual([])
    } finally {
      release()
      await sent
      await Effect.runPromise(Fiber.interrupt(read))
    }
  })
})

it("does not revive a thread archived while its first send waits for setup", async () => {
  await withPreparingThread(async ({ runner, threads, thread, waiting, turns, release }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "do not run after archive", []))
    await waiting
    expect((await Effect.runPromise(threads.archive(thread.id))).status).toBe("archived")
    release()
    expect(Exit.isFailure(await sent)).toBe(true)
    expect(turns).toStrictEqual([])
    expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("archived")
  })
})

it("interrupts an unsent first message and releases its send claim", async () => {
  await withPreparingThread(async ({ runner, thread, waiting, turns, release }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "do not deliver", []))
    await waiting
    expect(Exit.isFailure(await Effect.runPromiseExit(runner.send(thread.id, "duplicate", [])))).toBe(true)
    await Effect.runPromise(runner.interrupt(thread.id))
    release()
    expect(Exit.isFailure(await sent)).toBe(true)
    expect(turns).toStrictEqual([])
    expect((await Effect.runPromise(runner.transcript(thread.id))).messages).toStrictEqual([])
    expect(Exit.isSuccess(await Effect.runPromiseExit(runner.send(thread.id, "try again", [])))).toBe(true)
  })
})

it("uses the current provider, account and model after preparation", async () => {
  await withPreparingThread(async ({ runner, threads, accounts, root, thread, waiting, turns, release }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "use my new selection", []))
    await waiting
    const account = await Effect.runPromise(
      accounts.create({ provider: "codex", name: "Selected", configDir: join(root, "profile"), binary: "test-codex" }),
    )
    await Effect.runPromise(
      threads.update({ id: thread.id, provider: "codex", accountId: account.id, model: "current-model" }),
    )
    release()
    expect(Exit.isSuccess(await sent)).toBe(true)
    expect(turns).toMatchObject([
      { provider: "codex", input: { model: "current-model", home: { dir: account.configDir, binary: "test-codex" } } },
    ])
  })
})

it("cancels a prepared send still waiting to enter the delivery lock", async () => {
  await withPreparingThread(async ({ runner, worktrees, thread, waiting, prepared, turns, release }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "cancel at the boundary", []))
    await waiting
    const unlock = Effect.runSync(Deferred.make<void>())
    const locked = Promise.withResolvers<void>()
    const holder = Effect.runFork(
      worktrees.exclusive(Effect.sync(() => locked.resolve()).pipe(Effect.andThen(Deferred.await(unlock)))),
    )
    try {
      await locked.promise
      release()
      await prepared
      await Effect.runPromise(runner.interrupt(thread.id))
      await Effect.runPromise(Deferred.succeed(unlock, undefined))
      expect(Exit.isFailure(await sent)).toBe(true)
      expect(turns).toStrictEqual([])
      expect((await Effect.runPromise(runner.transcript(thread.id))).messages).toStrictEqual([])
    } finally {
      await Effect.runPromise(Deferred.succeed(unlock, undefined))
      await Effect.runPromise(Fiber.join(holder))
    }
  })
})

it("carries Stop during message admission through the provider-start handoff", async () => {
  await withPreparingThread(async ({ runner, thread, waiting, inserting, idle, turns, release, deliver }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "accepted then interrupted", []))
    await waiting
    release()
    await inserting
    await Effect.runPromise(runner.interrupt(thread.id))
    deliver()
    expect(Exit.isSuccess(await sent)).toBe(true)
    await Effect.runPromise(Effect.yieldNow)
    expect(turns).toStrictEqual([])
    await idle
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    expect(messages.map((message) => message.role)).toStrictEqual(["user", "assistant"])
    expect(messages.every((message) => message.completedAt !== null)).toBe(true)
  }, true)
})

it("does not deliver a pending send after its thread is deleted", async () => {
  await withPreparingThread(async ({ runner, threads, thread, waiting, turns, release }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "deleted task", []))
    await waiting
    await Effect.runPromise(threads.remove(thread.id))
    release()
    expect(Exit.isFailure(await sent)).toBe(true)
    expect(turns).toStrictEqual([])
  })
})
