import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vitest"
import type { AgentEvent, ApprovalDecision, ProviderId, RunTurnInput } from "../../shared/agent.ts"
import type { Message, Thread } from "../../shared/domain.ts"
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
import { PullRequestWatcher, layer as watcherLayer } from "./PullRequestWatcher.ts"
import { Secrets } from "./Secrets.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { ThreadNaming } from "./ThreadNaming.ts"
import * as Threads from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

interface Probe {
  readonly runner: AgentRunner["Service"]
  readonly threads: Threads.Threads["Service"]
  readonly worktrees: Worktrees.Worktrees["Service"]
  readonly accounts: AgentAccounts.AgentAccounts["Service"]
  readonly pullRequests: PullRequests.PullRequests["Service"]
  readonly watcher: PullRequestWatcher["Service"]
  readonly root: string
  readonly thread: Thread
  readonly waiting: Promise<void>
  readonly prepared: Promise<void>
  readonly inserting: Promise<void>
  readonly snapshotting: Promise<void>
  readonly idle: Promise<void>
  readonly turns: Array<{ readonly provider: ProviderId; readonly input: RunTurnInput }>
  readonly decisions: Array<{ readonly requestId: string; readonly decision: ApprovalDecision }>
  readonly release: () => void
  readonly deliver: () => void
  readonly snapshot: () => void
  readonly pauseSnapshot: () => void
  readonly turnBase: () => Promise<string | null>
  readonly storedMessages: (threadId: string) => Promise<ReadonlyArray<Message>>
}

const withPreparingThread = async (
  run: (probe: Probe) => Promise<void>,
  options: { readonly pauseInsertion?: boolean; readonly pauseSnapshot?: boolean; readonly forkable?: boolean } = {},
) => {
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
  const snapshotting = Promise.withResolvers<void>()
  const snapshotReady = Promise.withResolvers<void>()
  const idle = Promise.withResolvers<void>()
  const deliver = () => inserted.resolve()
  const snapshot = () => snapshotReady.resolve()
  let holdInsertion = options.pauseInsertion ?? false
  let holdSnapshot = options.pauseSnapshot ?? false
  const turns: Probe["turns"] = []
  const decisions: Probe["decisions"] = []
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
    Layer.provideMerge(Db.layer(join(dir, "hinacode.sqlite"))),
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
      Stream.suspend((): Stream.Stream<AgentEvent> => {
        turns.push({ provider: id, input })
        const completed: AgentEvent = {
          type: "turn_completed",
          ...(options.forkable && { forkPoint: { sessionId: `${id}-session`, checkpoint: "turn-1" } }),
        }
        // A turn on a switched thread gets the handoff ahead of the prompt.
        if (input.prompt.endsWith("accepted input")) {
          return Stream.make({ type: "session_bound", providerSessionId: `${id}-session` }, completed)
        }
        if (input.prompt !== "needs approval") return Stream.never
        const requested: AgentEvent = {
          type: "approval_requested",
          request: {
            id: "approval-1",
            threadId: input.threadId,
            provider: id,
            kind: "command",
            title: "Run command",
            detail: "echo hi",
            input: { command: "echo hi" },
            sessionScope: { tool: "Bash", kind: "command", value: "echo hi" },
          },
        }
        return Stream.concat(Stream.make(requested), Stream.never)
      }),
    steer: () => Effect.void,
    interrupt: () => Effect.void,
    setAccessMode: () => Effect.void,
    respondApproval: (requestId, decision) => Effect.sync(() => decisions.push({ requestId, decision })),
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
            'while [ ! -f "$HINACODE_ROOT_PATH/release" ]; do sleep 0.02; done',
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
    const threads = Context.get(context, Threads.Threads)
    const sql = Context.get(context, SqlClient.SqlClient)
    const runnerRuntime = ManagedRuntime.make(
      watcherLayer.pipe(
        Layer.provideMerge(layer),
        Layer.provideMerge(PullRequests.layer),
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
            Layer.succeed(Threads.Threads, {
              ...threads,
              captureTurnBase: (cwd) =>
                Effect.gen(function* () {
                  if (holdSnapshot) {
                    holdSnapshot = false
                    snapshotting.resolve()
                    yield* Effect.promise(() => snapshotReady.promise)
                  }
                  return yield* threads.captureTurnBase(cwd)
                }),
            }),
            Layer.mock(GitHub.GitHub, {
              pullRequestDetail: (url) =>
                Effect.succeed({
                  url,
                  number: 7,
                  title: "Fix the thing",
                  status: "open",
                  checks: "failing",
                  review: null,
                  author: "octocat",
                  headRefName: "fix/pending",
                  baseRefName: "main",
                  additions: 1,
                  deletions: 0,
                  body: "",
                  baseRef: "main",
                  headRef: "fix/pending",
                  head: "abc1234",
                  mergeable: "mergeable",
                  changedFiles: 1,
                  checkRuns: [{ name: "CI / test", status: "failing", url: "https://ci.example/test" }],
                }),
            }),
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
        pullRequests: await runnerRuntime.runPromise(PullRequests.PullRequests),
        watcher: await runnerRuntime.runPromise(PullRequestWatcher),
        root,
        thread,
        waiting: waiting.promise,
        prepared: prepared.promise,
        inserting: inserting.promise,
        snapshotting: snapshotting.promise,
        idle: idle.promise,
        turns,
        decisions,
        release,
        deliver,
        snapshot,
        pauseSnapshot: () => {
          holdSnapshot = true
        },
        storedMessages: (threadId) => domainRuntime.runPromise(messages.list(threadId)),
        turnBase: () =>
          domainRuntime.runPromise(
            sql<{
              readonly turnBaseTree: string | null
            }>`SELECT turn_base_tree FROM thread WHERE id = ${thread.id}`.pipe(
              Effect.map((rows) => rows[0]?.turnBaseTree ?? null),
            ),
          ),
      })
    } finally {
      deliver()
      snapshot()
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

it("refuses a send whose worktree is removed before the turn is admitted", async () => {
  await withPreparingThread(async ({ runner, threads, worktrees, thread, prepared, turns, release }) => {
    release()
    await Effect.runPromise(worktrees.whenPrepared(thread.worktreeId!))
    const removing = Effect.runSync(Deferred.make<void>())
    const locked = Promise.withResolvers<void>()
    const holder = Effect.runFork(
      worktrees.exclusive(
        Effect.sync(() => locked.resolve()).pipe(
          Effect.andThen(Deferred.await(removing)),
          Effect.andThen(worktrees.removeWhileExclusive(thread.worktreeId!, "keep")),
        ),
      ),
    )
    try {
      await locked.promise
      const sent = Effect.runPromiseExit(runner.send(thread.id, "run in the worktree", []))
      await prepared
      await Effect.runPromise(Deferred.succeed(removing, undefined))
      await Effect.runPromise(Fiber.join(holder))

      const exit = await sent
      expect(turns.map((turn) => turn.input.cwd)).toStrictEqual([])
      expect(Exit.isFailure(exit)).toBe(true)
      expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle")
    } finally {
      await Effect.runPromise(Deferred.succeed(removing, undefined))
      await Effect.runPromise(Fiber.await(holder))
    }
  })
})

it("carries Stop during message admission through the provider-start handoff", async () => {
  await withPreparingThread(
    async ({ runner, thread, waiting, inserting, idle, turns, release, deliver }) => {
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
    },
    { pauseInsertion: true },
  )
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

it("drops stopped watch news after it waits for setup", async () => {
  await withPreparingThread(async ({ runner, threads, thread, waiting, turns, release, pullRequests, watcher }) => {
    const url = "https://github.com/o/setup/pull/7"
    const first = await Effect.runPromise(pullRequests.watch(thread.id, url, ["checksFailed"]))
    const polling = Effect.runPromise(watcher.sweep)
    await waiting
    expect((await Effect.runPromise(runner.transcript(thread.id))).messages).toStrictEqual([])
    await Effect.runPromise(pullRequests.unwatch(thread.id, url))
    const replacement = await Effect.runPromise(pullRequests.watch(thread.id, url, ["reviewChanged"]))
    release()
    await polling

    expect(turns).toStrictEqual([])
    expect((await Effect.runPromise(runner.transcript(thread.id))).messages).toStrictEqual([])
    expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle")
    expect((await Effect.runPromise(pullRequests.find(first.id)))?.watch).toStrictEqual(replacement.watch)
    expect(Exit.isSuccess(await Effect.runPromiseExit(runner.send(thread.id, "new input", [])))).toBe(true)
    expect(turns.map((turn) => turn.input.prompt)).toStrictEqual(["new input"])
  })
})

it("keeps a thread archived when watch news waits for setup", async () => {
  await withPreparingThread(async ({ runner, threads, thread, waiting, turns, release, pullRequests, watcher }) => {
    const url = "https://github.com/o/archived-setup/pull/7"
    await Effect.runPromise(pullRequests.watch(thread.id, url, ["checksFailed"]))
    const polling = Effect.runPromise(watcher.sweep)
    await waiting
    await Effect.runPromise(threads.archive(thread.id))
    release()
    await polling

    expect(turns).toStrictEqual([])
    expect((await Effect.runPromise(runner.transcript(thread.id))).messages).toStrictEqual([])
    expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("archived")
  })
})

it("drops watch news stopped while the turn snapshot is pending", async () => {
  await withPreparingThread(
    async ({ runner, thread, snapshotting, turns, release, snapshot, pullRequests, watcher }) => {
      const url = "https://github.com/o/snapshot/pull/7"
      const first = await Effect.runPromise(pullRequests.watch(thread.id, url, ["checksFailed"]))
      release()
      const polling = Effect.runPromise(watcher.sweep)
      await snapshotting
      await Effect.runPromise(pullRequests.unwatch(thread.id, url))
      const replacement = await Effect.runPromise(pullRequests.watch(thread.id, url, ["reviewChanged"]))
      snapshot()
      await polling

      expect(turns).toStrictEqual([])
      expect((await Effect.runPromise(runner.transcript(thread.id))).messages).toStrictEqual([])
      expect((await Effect.runPromise(pullRequests.find(first.id)))?.watch).toStrictEqual(replacement.watch)
    },
    { pauseSnapshot: true },
  )
})

const acceptedTurnWithEdits = async (probe: Probe) => {
  probe.release()
  await Effect.runPromise(probe.runner.send(probe.thread.id, "accepted input", []))
  await probe.idle
  const messages = (await Effect.runPromise(probe.runner.transcript(probe.thread.id))).messages
  expect(messages).toHaveLength(2)
  if (probe.thread.worktreeId === null) throw new Error("preparing thread has no worktree")
  const worktree = await Effect.runPromise(probe.worktrees.get(probe.thread.worktreeId))
  writeFileSync(join(worktree.path, "edited.txt"), "user edit\n")
  const baseline = await probe.turnBase()
  const changes = await Effect.runPromise(probe.threads.changes(probe.thread.id, "turn"))
  expect(baseline).not.toBeNull()
  expect(changes?.files.map((file) => file.path)).toContain("edited.txt")
  probe.pauseSnapshot()
  return { baseline, changes, messages }
}

it("tells the agent the branch and paths it works in", async () => {
  await withPreparingThread(async (probe) => {
    probe.release()
    await Effect.runPromise(probe.runner.send(probe.thread.id, "accepted input", []))
    await probe.idle
    const worktree = await Effect.runPromise(probe.worktrees.get(probe.thread.worktreeId!))

    expect(probe.turns[0]?.input.instructions).toContain(`<environment>
  is a git repository: true
  git branch: \`fix/pending\`
  current project path: \`${worktree.path}\`
  root project path: \`${probe.root}\`
  remote: \`(none)\`
  platform: ${process.platform}
</environment>`)
  })
})

it("preserves the accepted turn baseline when a watch stops during snapshot capture", async () => {
  await withPreparingThread(async (probe) => {
    const before = await acceptedTurnWithEdits(probe)
    const url = "https://github.com/o/baseline/pull/7"
    await Effect.runPromise(probe.pullRequests.watch(probe.thread.id, url, ["checksFailed"]))
    const polling = Effect.runPromise(probe.watcher.sweep)
    await probe.snapshotting
    await Effect.runPromise(probe.pullRequests.unwatch(probe.thread.id, url))
    probe.snapshot()
    await polling

    expect(probe.turns.map((turn) => turn.input.prompt)).toStrictEqual(["accepted input"])
    expect((await Effect.runPromise(probe.runner.transcript(probe.thread.id))).messages).toStrictEqual(before.messages)
    expect(await Effect.runPromise(probe.threads.changes(probe.thread.id, "turn"))).toStrictEqual(before.changes)
    expect(await probe.turnBase()).toBe(before.baseline)
  })
})

it("preserves the accepted turn baseline when pending Stop interrupts snapshot capture", async () => {
  await withPreparingThread(async (probe) => {
    const before = await acceptedTurnWithEdits(probe)
    const sending = Effect.runPromiseExit(probe.runner.send(probe.thread.id, "do not change the baseline", []))
    await probe.snapshotting
    await Effect.runPromise(probe.runner.interrupt(probe.thread.id))
    probe.snapshot()
    expect(Exit.isFailure(await sending)).toBe(true)

    expect(probe.turns.map((turn) => turn.input.prompt)).toStrictEqual(["accepted input"])
    expect((await Effect.runPromise(probe.runner.transcript(probe.thread.id))).messages).toStrictEqual(before.messages)
    expect(await Effect.runPromise(probe.threads.changes(probe.thread.id, "turn"))).toStrictEqual(before.changes)
    expect(await probe.turnBase()).toBe(before.baseline)
  })
})

it("allows the approval a turn is waiting on when the thread switches to full access", async () => {
  await withPreparingThread(async ({ runner, thread, release, decisions }) => {
    release()
    expect(Exit.isSuccess(await Effect.runPromiseExit(runner.send(thread.id, "needs approval", [])))).toBe(true)
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
    )
    await Effect.runPromise(runner.setAccessMode(thread.id, "full"))
    expect(decisions).toStrictEqual([{ requestId: "approval-1", decision: "allow" }])
  })
})

it("moves a started thread to another agent and persists its marker without a fork point", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, idle, turns, storedMessages }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await idle
    expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).toBe("claude-session")

    const switched = await Effect.runPromise(
      runner.switchAgent({ id: thread.id, provider: "codex", model: "codex-model" }),
    )
    expect(switched).toMatchObject({ provider: "codex", model: "codex-model", providerSessionId: null })
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    expect(messages.at(-1)?.parts).toStrictEqual([{ type: "agent_switch", from: "claude", to: "codex" }])
    expect((await storedMessages(thread.id)).at(-1)).toMatchObject({
      parts: [{ type: "agent_switch", from: "claude", to: "codex" }],
      forkPoint: null,
    })

    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).toBe("codex-session"),
    )
    const handoff = turns[1]!
    expect(handoff.provider).toBe("codex")
    expect(handoff.input.resumeSessionId).toBeNull()
    expect(handoff.input.prompt).toMatch(
      /^<conversation_handoff>\nThis conversation started with Claude Code and continues with you\./,
    )
    expect(handoff.input.prompt).toContain("## user\naccepted input\n\n## assistant\n[the conversation moved")
    expect(handoff.input.prompt).toMatch(/<\/conversation_handoff>\n\naccepted input$/)
  })
})

it("keeps a native fork's first prompt explicit while preserving its session checkpoint", async () => {
  await withPreparingThread(
    async ({ runner, threads, thread, release, idle, turns, storedMessages }) => {
      release()
      await Effect.runPromise(runner.send(thread.id, "accepted input", []))
      await idle
      await vi.waitFor(async () =>
        expect((await storedMessages(thread.id)).at(-1)?.forkPoint).toMatchObject({
          sessionId: "claude-session",
          checkpoint: "turn-1",
          owner: { provider: "claude", accountId: null },
        }),
      )
      const reply = (await storedMessages(thread.id)).at(-1)!
      const fork = await Effect.runPromise(threads.fork(thread.id, reply.id))
      expect(fork).toMatchObject({
        providerSessionId: null,
        forkedFrom: { sessionId: "claude-session", checkpoint: "turn-1" },
      })

      await Effect.runPromise(runner.send(fork.id, "accepted input", []))
      await vi.waitFor(() => expect(turns).toHaveLength(2))
      expect(turns[1]).toMatchObject({
        provider: "claude",
        input: {
          threadId: fork.id,
          prompt: "accepted input",
          resumeSessionId: "claude-session",
          forkAt: "turn-1",
        },
      })
    },
    { forkable: true },
  )
})

it("refuses to switch agents while a turn runs", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "needs approval", []))
    const exit = await Effect.runPromiseExit(runner.switchAgent({ id: thread.id, provider: "codex", model: "m" }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect((await Effect.runPromise(threads.get(thread.id))).provider).toBe("claude")
  })
})
