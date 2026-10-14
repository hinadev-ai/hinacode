import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Stream } from "effect"
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
  readonly thread: Thread
  readonly waiting: Promise<void>
  readonly turns: Array<{ readonly provider: ProviderId; readonly input: RunTurnInput }>
  readonly release: () => void
}

const withPreparingThread = async (run: (probe: Probe) => Promise<void>) => {
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
              connectionFor: () => Effect.succeed({ url: "http://127.0.0.1:1", headers: {} }),
              authenticate: () => Option.none(),
              listening: () => Effect.void,
            }),
            Layer.succeed(ThreadNaming, { nameFromPrompt: () => Effect.void }),
            Layer.succeed(Worktrees.Worktrees, {
              ...worktrees,
              whenPrepared: (id) =>
                Effect.sync(() => waiting.resolve()).pipe(Effect.andThen(worktrees.whenPrepared(id))),
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
        thread,
        waiting: waiting.promise,
        turns,
        release,
      })
    } finally {
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

it("uses the current provider and model after preparation", async () => {
  await withPreparingThread(async ({ runner, threads, thread, waiting, turns, release }) => {
    const sent = Effect.runPromiseExit(runner.send(thread.id, "use my new selection", []))
    await waiting
    await Effect.runPromise(threads.update({ id: thread.id, provider: "codex", model: "current-model" }))
    release()
    expect(Exit.isSuccess(await sent)).toBe(true)
    expect(turns).toMatchObject([{ provider: "codex", input: { model: "current-model" } }])
  })
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
