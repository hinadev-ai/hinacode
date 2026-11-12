import { execFileSync } from "node:child_process"
import * as SourceControl from "./SourceControl.ts"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Queue, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { CHART_GUIDE } from "@hinacode/artifacts"
import { vi } from "vitest"
import type {
  AgentEvent,
  ApprovalDecision,
  BackgroundTask,
  ProviderId,
  RunTurnInput,
  Subagent,
} from "../../shared/agent.ts"
import { RpcMethods, type TranscriptPush } from "../../shared/contract.ts"
import { persistence } from "./errors.ts"
import { defaultSettings, type Message, type Settings as SettingsValue, type Thread } from "../../shared/domain.ts"
import { ClaudeProvider, makeClaudeHarness } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { DOCUMENT_COMMAND, expandDocumentCommand } from "../agents/document.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { AgentError, type AgentProvider, type SessionInput, type SteerPriority, type Wake } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { McpCredentials } from "../mcp/credentials.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { AgentRunner, layer } from "./AgentRunner.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import * as Attachments from "./Attachments.ts"
import * as Messages from "./Messages.ts"
import * as Projects from "./Projects.ts"
import * as PullRequests from "./PullRequests.ts"
import { PullRequestWatcher, layer as watcherLayer } from "./PullRequestWatcher.ts"
import { Secrets } from "./Secrets.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import * as Scratch from "./Scratch.ts"
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
  readonly streamed: Promise<void>
  readonly turns: Array<{ readonly provider: ProviderId; readonly input: RunTurnInput }>
  readonly nextTurn: () => Promise<void>
  readonly warms: Array<SessionInput>
  readonly modelLists: Array<ProviderId>
  readonly setSettings: (patch: Partial<SettingsValue>) => Promise<void>
  readonly decisions: Array<{ readonly requestId: string; readonly decision: ApprovalDecision; readonly note?: string }>
  readonly steers: Array<{ readonly text: string; readonly priority: SteerPriority }>
  readonly calls: Array<{ readonly provider: ProviderId; readonly call: "closeSession" | "interrupt" }>
  readonly stops: Array<string>
  readonly setBackgroundTasks: (tasks: ReadonlyArray<BackgroundTask>) => void
  readonly reportSubagent: (subagent: Subagent) => void
  readonly hitLimit: () => void
  readonly transcript: Array<TranscriptPush>
  readonly wake: (agent: ProviderId, sessionId: string, events?: ReadonlyArray<AgentEvent>) => Promise<void>
  readonly failClose: () => void
  readonly release: () => void
  readonly deliver: () => void
  readonly snapshot: () => void
  readonly pauseSnapshot: () => void
  readonly pauseNextUpdate: () => { readonly reached: Promise<void>; readonly resume: () => void }
  readonly turnBase: () => Promise<string | null>
  readonly storedMessages: (threadId: string) => Promise<ReadonlyArray<Message>>
  readonly failNextInsert: (matches: (message: Message) => boolean) => void
  readonly recordAfterCheck: (message: Message) => void
}

const streamedWords = Array.from({ length: 400 }, (_, index) => `word${index} `)

const subagentReport = `REPORT_START\n${"finding\n".repeat(1000)}REPORT_END`

const survey = (status: Subagent["status"]): Subagent => ({
  id: "native-1",
  label: "Survey",
  callId: "spawn",
  status,
  summary: status === "running" ? null : "Surveyed 12 files.",
  lastTool: null,
  toolUses: 0,
  tokens: null,
  startedAt: "2026-11-03T00:00:00.000Z",
  endedAt: status === "running" ? null : "2026-11-03T00:05:00.000Z",
})

const nativeSubagent = (status: Subagent["status"]): AgentEvent => ({
  type: "subagent_updated",
  subagent: survey(status),
})

const wakeQueue = () => Effect.runSync(Queue.unbounded<Wake>())

const withPreparingThread = async (
  run: (probe: Probe) => Promise<void>,
  options: {
    readonly pauseInsertion?: boolean
    readonly pauseSnapshot?: boolean
    readonly forkable?: boolean
    readonly claude?: Layer.Layer<ClaudeProvider>
  } = {},
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
  const streamed = Promise.withResolvers<void>()
  const deliver = () => inserted.resolve()
  const snapshot = () => snapshotReady.resolve()
  let holdInsertion = options.pauseInsertion ?? false
  let failingInsert: ((message: Message) => boolean) | undefined
  let recordedAfterCheck: Message | undefined
  let holdSnapshot = options.pauseSnapshot ?? false
  let updateHold:
    | { readonly reached: PromiseWithResolvers<void>; readonly resumed: PromiseWithResolvers<void> }
    | undefined
  const turns: Probe["turns"] = []
  let turnStarted = Promise.withResolvers<void>()
  const warms: Probe["warms"] = []
  const modelLists: Probe["modelLists"] = []
  const decisions: Probe["decisions"] = []
  const steers: Probe["steers"] = []
  const resolutions = Effect.runSync(Queue.unbounded<AgentEvent>())
  const interruptions = Effect.runSync(Queue.unbounded<AgentEvent>())
  const limits = Effect.runSync(Queue.unbounded<AgentEvent>())
  const calls: Probe["calls"] = []
  const stops: Probe["stops"] = []
  const subagentChanges = Effect.runSync(Queue.unbounded<{ readonly threadId: string; readonly subagent: Subagent }>())
  const backgroundTaskChanges = Effect.runSync(
    Queue.unbounded<{ readonly threadId: string; readonly tasks: ReadonlyArray<BackgroundTask> }>(),
  )
  const transcript: Probe["transcript"] = []
  let closeFails = false
  const wakes = {
    claude: wakeQueue(),
    codex: wakeQueue(),
    muse: wakeQueue(),
    opencode: wakeQueue(),
    magpie: wakeQueue(),
  }
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Scratch.layer(join(dir, "scratch"), { tmpRoot: join(dir, "tmp") })),
      Layer.provide(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer(dir)),
    ),
    Messages.layer,
    Attachments.layer(join(dir, "attachments")),
  ).pipe(
    Layer.provideMerge(
      SourceControl.layer.pipe(Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer))).pipe(
        Layer.provideMerge(
          Layer.succeed(Events, {
            publish: (event) =>
              Effect.sync(() => {
                if (event.type === "worktree.setupLog" && event.chunk.includes("setup started")) started.resolve()
                if (event.type === "thread.updated" && event.thread.status === "idle") idle.resolve()
                if ("seq" in event) transcript.push(event)
              }),
          }),
        ),
      ),
    ),
    Layer.provideMerge(Db.layer(join(dir, "hinacode.sqlite"))),
    Layer.provide(NodeServices.layer),
  )
  const domainRuntime = ManagedRuntime.make(domain)
  const provider = (id: ProviderId): AgentProvider => ({
    id,
    listModels: Effect.sync(() => {
      modelLists.push(id)
      return []
    }),
    account: () => Effect.succeed({ type: "apiKey" }),
    planLimits: () => Effect.succeed(null),
    usage: () => Effect.succeed(null),
    listCommands: () => Effect.succeed([]),
    runTurn: (input) =>
      Stream.suspend((): Stream.Stream<AgentEvent, AgentError> => {
        turns.push({ provider: id, input })
        turnStarted.resolve()
        turnStarted = Promise.withResolvers<void>()
        const completed: AgentEvent = {
          type: "turn_completed",
          ...(options.forkable && { forkPoint: { sessionId: `${id}-session`, checkpoint: "turn-1" } }),
        }
        if (input.prompt.endsWith("accepted input")) {
          return Stream.make({ type: "session_bound", providerSessionId: `${id}-session-${turns.length}` }, completed)
        }
        if (input.prompt === "streams, then waits") {
          return Stream.fromIterable<AgentEvent>(
            streamedWords.map((text): AgentEvent => ({ type: "text_delta", text })),
          ).pipe(
            Stream.concat(Stream.fromEffect(Effect.sync(() => streamed.resolve())).pipe(Stream.drain)),
            Stream.concat(Stream.never),
          )
        }
        const untilStopped = Stream.fromQueue(interruptions).pipe(
          Stream.takeUntil(({ type }) => type === "turn_failed"),
        )
        if (input.prompt === "waits for Stop") return untilStopped
        if (input.prompt === "spawns a sub-agent, then waits for Stop") {
          return Stream.concat(Stream.make(nativeSubagent("running")), untilStopped)
        }
        if (input.prompt === "spawns a background sub-agent, then ends") {
          return Stream.make(
            { type: "session_bound", providerSessionId: `${id}-session-${turns.length}` },
            nativeSubagent("running"),
            completed,
          )
        }
        if (input.prompt === "reads an image") {
          return Stream.fromIterable<AgentEvent>([
            { type: "tool_call_started", callId: "image-1", name: "Read", input: { file_path: "a.png" } },
            {
              type: "tool_call_finished",
              callId: "image-1",
              output: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
                { type: "image", data: "PHN2Zy8+", mimeType: "image/svg+xml" },
              ],
              isError: false,
            },
            completed,
          ])
        }
        if (input.prompt === "is signed out") {
          const loginCommand = "opencode auth login"
          return Stream.fail(new AgentError({ provider: id, message: "opencode is not signed in", loginCommand }))
        }
        if (input.prompt === "calls a tool, then waits") {
          return Stream.fromIterable<AgentEvent>([
            { type: "tool_call_started", callId: "call-1", name: "Bash", input: { command: "ls" } },
            { type: "tool_call_finished", callId: "call-1", output: "README.md", isError: false },
          ]).pipe(
            Stream.concat(Stream.fromEffect(Effect.sync(() => streamed.resolve())).pipe(Stream.drain)),
            Stream.concat(Stream.never),
          )
        }
        if (input.prompt === "streams a reply") {
          return Stream.fromIterable<AgentEvent>([
            ...streamedWords.map((text): AgentEvent => ({ type: "text_delta", text })),
            { type: "tool_call_started", callId: "call-1", name: "Bash", input: { command: "ls" } },
            { type: "tool_call_finished", callId: "call-1", output: "README.md", isError: false },
            ...streamedWords.map((text): AgentEvent => ({ type: "reasoning_delta", text })),
            completed,
          ])
        }
        if (input.prompt === "delegates") {
          return Stream.make(
            { type: "tool_call_started", callId: "spawn", name: "Agent", input: { description: "Survey" } },
            { type: "tool_call_finished", callId: "spawn", output: subagentReport, isError: false },
            completed,
          )
        }
        if (input.prompt === "ends silently") {
          return Stream.make({ type: "session_bound", providerSessionId: `${id}-session-${turns.length}` })
        }
        if (
          input.prompt !== "needs approval" &&
          input.prompt !== "needs two approvals" &&
          input.prompt !== "needs approval, then ends silently" &&
          input.prompt !== "needs approval, then hits its limit"
        )
          return Stream.never
        const approval = (requestId: string): AgentEvent => ({
          type: "approval_requested",
          request: {
            id: requestId,
            threadId: input.threadId,
            provider: id,
            kind: "command",
            title: "Run command",
            detail: "echo hi",
            input: { command: "echo hi" },
            sessionScope: { tool: "Bash", kind: "command", value: "echo hi" },
          },
        })
        if (input.prompt === "needs two approvals")
          return Stream.concat(
            Stream.make(approval("approval-1"), approval("approval-2")),
            Stream.fromQueue(resolutions),
          )
        if (input.prompt === "needs approval, then hits its limit")
          return Stream.concat(Stream.make(approval("approval-1")), Stream.take(Stream.fromQueue(limits), 1))
        return input.prompt === "needs approval"
          ? Stream.concat(Stream.make(approval("approval-1")), Stream.fromQueue(resolutions))
          : Stream.make(approval("approval-1"))
      }),
    warm: (input) => Effect.sync(() => void warms.push(input)),
    wakes: Stream.fromQueue(wakes[id]),
    ...(id === "claude" && {
      subagentChanges: Stream.fromQueue(subagentChanges),
      backgroundTasks: {
        changes: Stream.fromQueue(backgroundTaskChanges),
        stop: (_threadId: string, taskId: string) => Effect.sync(() => void stops.push(`task:${taskId}`)),
      },
    }),
    stopSubagent: (_threadId, subagentId) => Effect.sync(() => void stops.push(`subagent:${subagentId}`)),
    closeSession: () =>
      closeFails
        ? Effect.fail(new AgentError({ provider: id, message: "The session did not leave" }))
        : Effect.sync(() => calls.push({ provider: id, call: "closeSession" })),
    ...(id !== "opencode" && {
      steer: (_threadId: string, text: string, _attachments: unknown, priority: SteerPriority) =>
        Effect.sync(() => void steers.push({ text, priority })),
    }),
    interrupt: () =>
      Effect.sync(() => calls.push({ provider: id, call: "interrupt" })).pipe(
        Effect.andThen(Queue.offer(interruptions, { type: "turn_failed", message: "Interrupted" })),
      ),
    setAccessMode: () => Effect.void,
    respondApproval: (requestId, decision, note) =>
      Effect.sync(() => decisions.push({ requestId, decision, ...(note !== undefined && { note }) })).pipe(
        Effect.andThen(Queue.offer(resolutions, { type: "approval_resolved", requestId })),
        Effect.as(decision === "deny" && note !== undefined),
      ),
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
          accessMode: "supervised",
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
            options.claude ?? Layer.succeed(ClaudeProvider, provider("claude")),
            Layer.succeed(CodexProvider, provider("codex")),
            Layer.succeed(MuseProvider, provider("muse")),
            Layer.succeed(OpencodeProvider, provider("opencode")),
            Layer.succeed(MagpieProvider, provider("magpie")),
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
            Layer.succeed(ThreadNaming, {
              nameFromPrompt: () => Effect.void,
              regenerateTitle: () => Effect.die("unused"),
            }),
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
            SourceControl.layer.pipe(
              Layer.provideMerge(
                Layer.mock(GitHub.GitHub, {
                  installed: Effect.succeed(true),
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
                      labels: [],
                      assignees: [],
                      reviewers: [],
                      comments: [],
                      checkRuns: [{ name: "CI / test", status: "failing", url: "https://ci.example/test" }],
                    }),
                }),
              ),
            ),
            Layer.succeed(Messages.Messages, {
              ...messages,
              insert: (message) =>
                Effect.gen(function* () {
                  if (holdInsertion && message.role === "user") {
                    holdInsertion = false
                    inserting.resolve()
                    yield* Effect.promise(() => inserted.promise)
                  }
                  if (failingInsert?.(message)) {
                    failingInsert = undefined
                    return yield* persistence("messages.insert")(new Error("disk full"))
                  }
                  yield* messages.insert(message)
                }),
              has: (id) =>
                Effect.gen(function* () {
                  const sent = yield* messages.has(id)
                  const late = recordedAfterCheck
                  if (late?.id === id) {
                    recordedAfterCheck = undefined
                    yield* messages.insert(late)
                  }
                  return sent
                }),
              update: (message, previous) =>
                Effect.gen(function* () {
                  const hold = updateHold
                  updateHold = undefined
                  if (hold !== undefined) {
                    hold.reached.resolve()
                    yield* Effect.promise(() => hold.resumed.promise)
                  }
                  return yield* messages.update(message, previous)
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
        Layer.provide(NodeServices.layer),
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
        nextTurn: () => turnStarted.promise,
        streamed: streamed.promise,
        turns,
        warms,
        modelLists,
        setSettings: (patch) =>
          domainRuntime.runPromise(Settings.Settings.use((settings) => settings.set(patch)).pipe(Effect.asVoid)),
        decisions,
        steers,
        calls,
        stops,
        setBackgroundTasks: (tasks) => Queue.offerUnsafe(backgroundTaskChanges, { threadId: thread.id, tasks }),
        reportSubagent: (subagent) => Queue.offerUnsafe(subagentChanges, { threadId: thread.id, subagent }),
        hitLimit: () =>
          Queue.offerUnsafe(limits, {
            type: "turn_limited",
            limit: { kind: "org_spend", message: "Usage exhausted", reset: null },
          }),
        transcript,
        wake: (agent, sessionId, events) => {
          const discarded = Promise.withResolvers<void>()
          Queue.offerUnsafe(wakes[agent], {
            threadId: thread.id,
            sessionId,
            events: events === undefined ? Stream.never : Stream.fromIterable(events),
            discard: Effect.sync(() => discarded.resolve()),
          })
          return discarded.promise
        },
        failClose: () => {
          closeFails = true
        },
        release,
        deliver,
        snapshot,
        pauseSnapshot: () => {
          holdSnapshot = true
        },
        pauseNextUpdate: () => {
          const hold = { reached: Promise.withResolvers<void>(), resumed: Promise.withResolvers<void>() }
          updateHold = hold
          return { reached: hold.reached.promise, resume: () => hold.resumed.resolve() }
        },
        storedMessages: (threadId) => domainRuntime.runPromise(messages.list(threadId)),
        failNextInsert: (matches) => {
          failingInsert = matches
        },
        recordAfterCheck: (message) => {
          recordedAfterCheck = message
        },
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
`)
  })
})

it("lists models only for the enabled providers when a turn starts", async () => {
  await withPreparingThread(async (probe) => {
    await probe.setSettings({ providerEnabled: { ...defaultSettings.providerEnabled, codex: false, muse: false } })
    probe.release()
    await Effect.runPromise(probe.runner.send(probe.thread.id, "accepted input", []))
    await probe.idle

    expect(probe.modelLists).not.toContain("codex")
    expect(probe.modelLists).not.toContain("muse")
  })
})

it("hands the agent an artifact skill's instructions and keeps the message as typed", async () => {
  await withPreparingThread(async (probe) => {
    probe.release()
    await Effect.runPromise(probe.runner.send(probe.thread.id, "/artifact:doc audit startup imports", []))
    await vi.waitFor(() => expect(probe.turns).toHaveLength(1))

    const prompt = probe.turns[0]?.input.prompt ?? ""
    expect(prompt).toMatch(/^<hinacode-skill name="artifact:doc">\n/)
    expect(prompt).toContain("<request>\naudit startup imports\n</request>")
    const { messages } = await Effect.runPromise(probe.runner.transcript(probe.thread.id))
    expect(messages[0]?.parts).toStrictEqual([{ type: "text", text: "/artifact:doc audit startup imports" }])
    await Effect.runPromise(probe.runner.interrupt(probe.thread.id))
  })
})

it("warms the session with the same input the next send runs its turn with", async () => {
  await withPreparingThread(async ({ runner, thread, turns, warms, idle, release }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await idle

    await vi.waitFor(async () => {
      await Effect.runPromise(runner.warm(thread.id))
      expect(warms).toHaveLength(1)
    })
    await vi.waitFor(() => Effect.runPromise(runner.send(thread.id, "accepted input", [])))
    await vi.waitFor(() => expect(turns).toHaveLength(2))

    const { prompt: _prompt, attachments: _attachments, ...sent } = turns[1]!.input
    expect(warms).toStrictEqual([sent])
  })
})

const scratchDirectoryOf = (input: RunTurnInput | undefined) =>
  /scratch directory: `([^`]+)`/.exec(input?.instructions ?? "")?.[1]

it("names a scratch folder that exists and keeps its path after the title changes", async () => {
  await withPreparingThread(async ({ runner, threads, thread, turns, idle, release }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await idle
    const first = scratchDirectoryOf(turns[0]?.input)
    expect(first).toBeDefined()
    expect(existsSync(first!)).toBe(true)

    await Effect.runPromise(threads.update({ id: thread.id, title: "Renamed by auto titling" }))
    await vi.waitFor(() => Effect.runPromise(runner.send(thread.id, "accepted input", [])))
    await vi.waitFor(() => expect(turns).toHaveLength(2))

    expect(scratchDirectoryOf(turns[1]?.input)).toBe(first)
    expect(readdirSync(dirname(first!))).toHaveLength(1)
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

it("allows an approval a full access thread receives without showing it", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, decisions, transcript }) => {
    release()
    await Effect.runPromise(threads.update({ id: thread.id, accessMode: "full" }))
    await Effect.runPromise(runner.send(thread.id, "needs approval", []))
    await vi.waitFor(() => expect(decisions).toStrictEqual([{ requestId: "approval-1", decision: "allow" }]))

    const shown = transcript.filter((push) => push.type === "thread.event" && push.event.type === "approval_requested")
    expect(shown).toStrictEqual([])
    expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toStrictEqual([])
    expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running")
  })
})

it("allows an approval a full access thread receives in a turn its agent starts by itself", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, idle, wake, decisions, transcript }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await idle
    await Effect.runPromise(threads.update({ id: thread.id, accessMode: "full" }))
    const { providerSessionId } = await Effect.runPromise(threads.get(thread.id))
    void wake("claude", providerSessionId!, [
      {
        type: "approval_requested",
        request: {
          id: "wake-approval",
          threadId: thread.id,
          provider: "claude",
          kind: "command",
          title: "Run command",
          detail: "pnpm build",
        },
      },
    ])
    await vi.waitFor(() => expect(decisions).toStrictEqual([{ requestId: "wake-approval", decision: "allow" }]))

    const shown = transcript.filter((push) => push.type === "thread.event" && push.event.type === "approval_requested")
    expect(shown).toStrictEqual([])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("holds a steer sent during an approval and steers it after the allowed tool call", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, steers }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "needs approval", []))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
    )
    await Effect.runPromise(runner.steer(thread.id, "use pnpm", []))
    expect(steers).toStrictEqual([])
    expect((await Effect.runPromise(threads.get(thread.id))).queue).toMatchObject([{ text: "use pnpm", steer: true }])

    await Effect.runPromise(runner.respondApproval("approval-1", "allow"))
    await vi.waitFor(() => expect(steers).toStrictEqual([{ text: "use pnpm", priority: "next" }]))
    expect((await Effect.runPromise(threads.get(thread.id))).queue).toStrictEqual([])
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    expect(
      messages.some((message) => message.role === "user" && JSON.stringify(message.parts).includes("use pnpm")),
    ).toBe(true)
  })
})

it("steers a note the provider could not deliver ahead of the messages held during the approval", async () => {
  await withPreparingThread(async ({ runner, thread, release, steers, decisions }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "needs approval", []))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
    )
    await Effect.runPromise(runner.steer(thread.id, "held", []))
    await Effect.runPromise(runner.respondApproval("approval-1", "allow", "  then run lint  "))
    expect(decisions).toStrictEqual([{ requestId: "approval-1", decision: "allow", note: "then run lint" }])
    await vi.waitFor(() =>
      expect(steers).toStrictEqual([
        { text: "then run lint", priority: "next" },
        { text: "held", priority: "next" },
      ]),
    )
  })
})

it("queues a note for an agent that cannot steer, so it runs after the turn", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, decisions }) => {
    release()
    await Effect.runPromise(threads.update({ id: thread.id, provider: "opencode" }))
    await Effect.runPromise(runner.send(thread.id, "needs approval", []))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
    )
    await Effect.runPromise(runner.respondApproval("approval-1", "allow", "then run lint"))
    expect(decisions).toStrictEqual([{ requestId: "approval-1", decision: "allow", note: "then run lint" }])
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(0),
    )
    expect((await Effect.runPromise(threads.get(thread.id))).queue).toStrictEqual([
      { id: expect.any(String), text: "then run lint", attachments: [] },
    ])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("does not steer a note the provider delivered with the denial", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, steers, decisions }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "needs approval", []))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
    )
    await Effect.runPromise(runner.respondApproval("approval-1", "deny", "edit b.ts instead"))
    expect(decisions).toStrictEqual([{ requestId: "approval-1", decision: "deny", note: "edit b.ts instead" }])
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running"))
    expect(steers).toStrictEqual([])
    expect((await Effect.runPromise(threads.get(thread.id))).queue).toStrictEqual([])
  })
})

it("stays awaiting approval until the last open request is answered", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "needs two approvals", []))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(2),
    )
    await Effect.runPromise(runner.respondApproval("approval-1", "allow"))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
    )
    expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("awaiting_approval")

    await Effect.runPromise(runner.respondApproval("approval-2", "allow"))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running"))
  })
})

it("moves a started thread to another agent and persists its marker without a fork point", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, idle, turns, storedMessages }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await idle
    expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).toBe("claude-session-1")

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
      expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).toBe("codex-session-2"),
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

it("forks a side chat from the last finished turn and hands it the running one", async () => {
  await withPreparingThread(
    async ({ runner, threads, thread, release, idle, turns }) => {
      release()
      await Effect.runPromise(runner.send(thread.id, "accepted input", []))
      await idle
      await Effect.runPromise(runner.send(thread.id, "needs approval", []))
      await vi.waitFor(async () =>
        expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
      )

      const side = await Effect.runPromise(threads.sidechat(thread.id))
      await Effect.runPromise(runner.send(side.id, "why?", []))
      await vi.waitFor(() => expect(turns).toHaveLength(3))

      expect(turns[2]).toMatchObject({
        provider: "claude",
        input: { threadId: side.id, resumeSessionId: "claude-session", forkAt: "turn-1", accessMode: "supervised" },
      })
      expect(turns[2]!.input.prompt).toMatch(/^<side_chat>\n/)
      expect(turns[2]!.input.prompt).toContain("## user\nneeds approval")
      expect(turns[2]!.input.prompt).toMatch(/<\/side_chat>\n\nwhy\?$/)
      expect((await Effect.runPromise(threads.get(thread.id))).status).not.toBe("idle")
      expect((await Effect.runPromise(threads.get(side.id))).title).toBe(thread.title)
    },
    { forkable: true },
  )
})

it("hands a recovered side chat its own conversation", async () => {
  await withPreparingThread(
    async ({ runner, threads, thread, release, idle, turns, storedMessages }) => {
      release()
      await Effect.runPromise(runner.send(thread.id, "accepted input", []))
      await idle
      const side = await Effect.runPromise(threads.sidechat(thread.id))
      await Effect.runPromise(runner.send(side.id, "first question accepted input", []))
      await vi.waitFor(async () => {
        const last = (await storedMessages(side.id)).filter((message) => message.role === "assistant").at(-1)
        expect(last?.completedAt ?? null).not.toBeNull()
      })

      await Effect.runPromise(threads.update({ id: side.id, providerSessionId: null }))
      await Effect.runPromise(runner.send(side.id, "second question accepted input", []))
      await vi.waitFor(() => expect(turns).toHaveLength(3))

      const prompt = turns[2]!.input.prompt
      expect(prompt).toMatch(/^<side_chat>\n/)
      expect(prompt).toContain("This side chat ran in an earlier session")
      expect(prompt).toContain("## user\nfirst question accepted input")
      expect(prompt).toContain("## user\naccepted input")
      expect(prompt).toMatch(/<\/side_chat>\n\nsecond question accepted input$/)
    },
    { forkable: true },
  )
})

it("numbers each thread's transcript pushes on its own", async () => {
  await withPreparingThread(
    async ({ runner, threads, thread, release, idle, transcript }) => {
      release()
      await Effect.runPromise(runner.send(thread.id, "accepted input", []))
      await idle
      const side = await Effect.runPromise(threads.sidechat(thread.id))
      await Effect.runPromise(runner.send(side.id, "accepted input", []))
      const seqsOf = (threadId: string) =>
        transcript
          .filter((push) => (push.type === "thread.event" ? push.threadId : push.message.threadId) === threadId)
          .map((push) => push.seq)
      await vi.waitFor(() =>
        expect(
          transcript.some(
            (push) => push.type === "thread.event" && push.threadId === side.id && push.event.type === "turn_completed",
          ),
        ).toBe(true),
      )

      for (const id of [thread.id, side.id]) {
        const seqs = seqsOf(id)
        expect(seqs).toEqual(seqs.map((_, index) => index + 1))
        expect((await Effect.runPromise(runner.transcript(id))).seq).toBe(seqs.length)
      }
      const snapshot = await Effect.runPromise(runner.transcript(thread.id))
      expect(snapshot.sequenceScope).toBe("thread")
      const { sequenceScope: _, ...legacySnapshot } = snapshot
      const decodeSnapshot = Schema.decodeUnknownSync(RpcMethods["threads.transcript"].response)
      expect(decodeSnapshot(legacySnapshot).sequenceScope).toBeUndefined()
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

it("retires the agent a thread leaves and turns away its wakes, even after switching back", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, idle, calls, wake }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await idle
    await Effect.runPromise(runner.switchAgent({ id: thread.id, provider: "codex", model: "codex-model" }))
    await Effect.runPromise(runner.switchAgent({ id: thread.id, provider: "claude", model: "claude-model" }))
    expect(calls).toStrictEqual([
      { provider: "claude", call: "closeSession" },
      { provider: "codex", call: "closeSession" },
    ])

    await wake("claude", "claude-session-1")
    expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle")
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    expect(messages.at(-1)?.parts).toStrictEqual([{ type: "agent_switch", from: "codex", to: "claude" }])

    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await vi.waitFor(async () =>
      expect(await Effect.runPromise(threads.get(thread.id))).toMatchObject({
        status: "idle",
        providerSessionId: "claude-session-2",
      }),
    )
    void wake("claude", "claude-session-2")
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running"))
    await Effect.runPromise(runner.interrupt(thread.id))
    expect(calls.at(-1)).toStrictEqual({ provider: "claude", call: "interrupt" })
  })
})

it("stops the thread's sub-agents and workflows with the turn, and keeps its shells and session", async () => {
  await withPreparingThread(async ({ runner, thread, release, calls, stops, setBackgroundTasks }) => {
    release()
    setBackgroundTasks([
      { id: "shell-1", kind: "shell", label: "pnpm dev", startedAt: "2026-11-03T00:00:00.000Z" },
      { id: "workflow-1", kind: "workflow", label: "Review", startedAt: "2026-11-03T00:00:00.000Z" },
    ])
    await Effect.runPromise(runner.send(thread.id, "spawns a sub-agent, then waits for Stop", []))
    await vi.waitFor(async () => expect(await Effect.runPromise(runner.subagents(thread.id))).toHaveLength(1))

    await Effect.runPromise(runner.interrupt(thread.id))

    expect(stops).toStrictEqual(["subagent:native-1", "task:workflow-1"])
    expect(calls).toStrictEqual([{ provider: "claude", call: "interrupt" }])
  })
})

it("closes the session after Stop when a wakeup is pending, so the wakeup never fires", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, calls, stops, setBackgroundTasks }) => {
    release()
    setBackgroundTasks([
      {
        id: "wakeup",
        kind: "wakeup",
        label: "Check CI",
        startedAt: "2026-11-03T00:00:00.000Z",
        firesAt: "2026-11-03T00:20:00.000Z",
      },
    ])
    await vi.waitFor(async () => expect(await Effect.runPromise(runner.backgroundTasks(thread.id))).toHaveLength(1))
    await Effect.runPromise(runner.send(thread.id, "waits for Stop", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running"))

    await Effect.runPromise(runner.interrupt(thread.id))

    await vi.waitFor(() => expect(calls).toContainEqual({ provider: "claude", call: "closeSession" }))
    expect(calls).toStrictEqual([
      { provider: "claude", call: "interrupt" },
      { provider: "claude", call: "closeSession" },
    ])
    expect(stops).toStrictEqual([])
  })
})

it("starts a turn with a steer that waited for the previous turn to finish", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, steers, turns, pauseNextUpdate }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "waits for Stop", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running"))
    const finishing = pauseNextUpdate()
    await Effect.runPromise(runner.interrupt(thread.id))
    await finishing.reached

    const late = Effect.runPromise(runner.steer(thread.id, "late", []))
    finishing.resume()
    await late

    expect(steers).toStrictEqual([])
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    expect(turns[1]?.input.prompt).toMatch(/\nlate$/)
  })
})

it("releases an idle thread by stopping its sub-agents and every task, shells too, and closing its session", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, calls, stops, setBackgroundTasks }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "spawns a background sub-agent, then ends", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))
    setBackgroundTasks([
      { id: "shell-1", kind: "shell", label: "pnpm dev", startedAt: "2026-11-06T00:00:00.000Z" },
      { id: "workflow-1", kind: "workflow", label: "Review", startedAt: "2026-11-06T00:00:00.000Z" },
    ])
    await vi.waitFor(async () => expect(await Effect.runPromise(runner.backgroundTasks(thread.id))).toHaveLength(2))

    expect(await Effect.runPromise(runner.release(thread.id, Effect.void))).toStrictEqual(Option.some(undefined))

    expect(stops).toStrictEqual(["subagent:native-1", "task:shell-1", "task:workflow-1"])
    expect(calls).toStrictEqual([{ provider: "claude", call: "closeSession" }])
  })
})

it("keeps the session of a thread whose turn is running when it releases the thread", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, calls }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "waits for Stop", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running"))

    expect(await Effect.runPromise(runner.release(thread.id, Effect.void))).toStrictEqual(Option.none())

    expect(calls).toStrictEqual([])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("holds back a send that arrives while a release cleans up, so the cleanup cannot hit the new turn", async () => {
  await withPreparingThread(async ({ runner, worktrees, thread, release, turns }) => {
    release()
    await Effect.runPromise(worktrees.whenPrepared(thread.worktreeId!))
    const cleaning = Promise.withResolvers<void>()
    const finish = Effect.runSync(Deferred.make<void>())
    const cleanup = Effect.sync(() => cleaning.resolve()).pipe(
      Effect.andThen(Deferred.await(finish)),
      Effect.andThen(Effect.sync(() => turns.length)),
    )
    const released = Effect.runPromise(runner.release(thread.id, cleanup))
    await Promise.race([cleaning.promise, released])

    const sent = Effect.runPromise(runner.send(thread.id, "accepted input", []))
    const startedDuringCleanup = await vi
      .waitFor(() => expect(turns).not.toHaveLength(0), { timeout: 500 })
      .then(
        () => true,
        () => false,
      )
    await Effect.runPromise(Deferred.succeed(finish, undefined))

    expect(startedDuringCleanup).toBe(false)
    expect(await released).toStrictEqual(Option.some(0))
    await sent
    expect(turns).toHaveLength(1)
  })
})

it("keeps a sub-agent running past its turn, then hands its reply to the idle thread", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, turns, reportSubagent }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "spawns a background sub-agent, then ends", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))
    expect(await Effect.runPromise(runner.subagents(thread.id))).toMatchObject([{ id: "native-1", status: "running" }])

    reportSubagent(survey("completed"))

    await vi.waitFor(() => expect(turns).toHaveLength(2))
    expect(await Effect.runPromise(runner.subagents(thread.id))).toMatchObject([
      { id: "native-1", status: "completed", summary: "Surveyed 12 files." },
    ])
    expect(turns[1]?.input.prompt).toContain("Survey")
    expect(turns[1]?.input.prompt).toContain("Surveyed 12 files.")
  })
})

it("does not wake the thread for a sub-agent the user stopped", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, turns, reportSubagent }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "spawns a background sub-agent, then ends", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))

    reportSubagent(survey("stopped"))

    await vi.waitFor(async () =>
      expect(await Effect.runPromise(runner.subagents(thread.id))).toMatchObject([{ status: "stopped" }]),
    )
    expect(turns).toHaveLength(1)
  })
})

it("still marks sub-agents stopped at the end of a turn when their agent cannot report them later", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release }) => {
    release()
    await Effect.runPromise(threads.update({ id: thread.id, provider: "opencode", model: "m" }))
    await Effect.runPromise(runner.send(thread.id, "spawns a background sub-agent, then ends", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))

    expect(await Effect.runPromise(runner.subagents(thread.id))).toMatchObject([{ id: "native-1", status: "stopped" }])
  })
})

it("marks sub-agents stopped when the thread leaves the agent that ran them", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "spawns a background sub-agent, then ends", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))

    await Effect.runPromise(runner.switchAgent({ id: thread.id, provider: "codex", model: "codex-model" }))

    expect(await Effect.runPromise(runner.subagents(thread.id))).toMatchObject([{ id: "native-1", status: "stopped" }])
  })
})

it("keeps a thread on its agent when that agent's session does not close", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, idle, failClose }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "accepted input", []))
    await idle
    failClose()
    const exit = await Effect.runPromiseExit(runner.switchAgent({ id: thread.id, provider: "codex", model: "m" }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Effect.runPromise(threads.get(thread.id))).toMatchObject({
      provider: "claude",
      providerSessionId: "claude-session-1",
    })
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    expect(messages.flatMap((message) => message.parts).some((part) => part.type === "agent_switch")).toBe(false)
  })
})

it("publishes the assistant message a turn closes when its stream ends without a terminal event", async () => {
  await withPreparingThread(async ({ runner, thread, release, idle, transcript, storedMessages }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "ends silently", []))
    await idle

    const stored = (await storedMessages(thread.id)).at(-1)!
    expect(stored).toMatchObject({ role: "assistant", completedAt: expect.any(String) })
    const updated = transcript.findLast((push) => push.type === "message.updated")
    expect(updated).toMatchObject({ type: "message.updated", message: stored })
  })
})

it("saves a tool's image as an attachment and keeps its bytes out of the transcript", async () => {
  await withPreparingThread(async ({ runner, thread, release, idle, transcript }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "reads an image", []))
    await idle

    const finished = transcript.find((push) => push.type === "thread.event" && push.event.type === "tool_call_finished")
    expect(JSON.stringify(finished)).not.toContain("aW1hZ2U=")
    expect(finished).toMatchObject({
      event: {
        output: [
          { type: "image", mimeType: "image/png", attachment: { kind: "image", mime: "image/png" } },
          { type: "image", mimeType: "image/svg+xml", attachment: { kind: "image", mime: "image/svg+xml" } },
        ],
      },
    })
    const output = (finished as unknown as { event: { output: Array<{ attachment: { path: string } }> } }).event.output
    expect(readFileSync(output[0]!.attachment.path, "utf8")).toBe("image")
    expect(output[1]!.attachment.path).toMatch(/\.svg$/)
  })
})

it("publishes a sub-agent's whole report", async () => {
  await withPreparingThread(async ({ runner, thread, release, idle, transcript }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "delegates", []))
    await idle

    const finished = transcript.find((push) => push.type === "thread.event" && push.event.type === "tool_call_finished")
    expect(finished).toMatchObject({ event: { output: subagentReport } })
  })
})

it("withdraws the requests a turn leaves unanswered when its stream ends without a terminal event", async () => {
  await withPreparingThread(async ({ runner, thread, release, idle, transcript }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "needs approval, then ends silently", []))
    await idle

    expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toEqual([])
    expect(transcript).toContainEqual(
      expect.objectContaining({
        type: "thread.event",
        threadId: thread.id,
        event: { type: "approval_resolved", requestId: "approval-1" },
      }),
    )
  })
})

it("withdraws the approval and secret requests a usage-limited turn leaves unanswered", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, transcript, hitLimit }) => {
    const pushed = (event: AgentEvent["type"]) =>
      transcript.some((push) => push.type === "thread.event" && push.event.type === event)
    release()
    await Effect.runPromise(runner.send(thread.id, "needs approval, then hits its limit", []))
    await vi.waitFor(() => expect(pushed("approval_requested")).toBe(true))
    const secret = Effect.runPromise(Effect.flip(runner.requestSecret(thread.id, "demo.token", "Demo token")))
    await vi.waitFor(() => expect(pushed("secret_requested")).toBe(true))

    hitLimit()

    expect((await secret).message).toBe("The turn ended before the user answered.")
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("limited"))
    const snapshot = await Effect.runPromise(runner.transcript(thread.id))
    expect(snapshot.approvals).toEqual([])
    expect(snapshot.secretRequests).toEqual([])
    expect(transcript).toContainEqual(
      expect.objectContaining({ event: { type: "approval_resolved", requestId: "approval-1" } }),
    )
    expect(pushed("secret_resolved")).toBe(true)
  })
})

it("keeps the login command when the agent is signed out", async () => {
  await withPreparingThread(async ({ runner, thread, release, idle, storedMessages }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "is signed out", []))
    await idle
    expect((await storedMessages(thread.id)).at(-1)?.parts).toEqual([
      { type: "signed_out", message: "opencode is not signed in", loginCommand: "opencode auth login" },
    ])
  })
})

it("publishes streamed text in fewer pushes, in order, with the same transcript", async () => {
  await withPreparingThread(async ({ runner, thread, release, idle, transcript, storedMessages }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "streams a reply", []))
    await idle

    const events = transcript.flatMap((push) => (push.type === "thread.event" ? [push.event] : []))
    const kinds = events.map((event) => event.type).filter((type, index, all) => type !== all[index - 1])
    expect(kinds).toEqual([
      "text_delta",
      "tool_call_started",
      "tool_call_finished",
      "reasoning_delta",
      "turn_completed",
    ])
    expect(events.length).toBeLessThan(streamedWords.length)
    const streamed = (type: AgentEvent["type"]) =>
      events.flatMap((event) => (event.type === type && "text" in event ? [event.text] : [])).join("")
    expect(streamed("text_delta")).toBe(streamedWords.join(""))
    expect(streamed("reasoning_delta")).toBe(streamedWords.join(""))

    const stored = (await storedMessages(thread.id)).at(-1)!
    expect(stored.parts).toEqual([
      { type: "text", text: streamedWords.join("") },
      {
        type: "tool_call",
        callId: "call-1",
        name: "Bash",
        input: { command: "ls" },
        status: "done",
        output: "README.md",
      },
      { type: "reasoning", text: streamedWords.join("") },
    ])
    const transcriptSeqs = transcript.map((push) => push.seq)
    expect(transcriptSeqs).toEqual(transcriptSeqs.toSorted((a, b) => a - b))
  })
})

it("ends a turn the user stopped without reporting an error", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, transcript }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "waits for Stop", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("running"))
    await Effect.runPromise(runner.interrupt(thread.id))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))

    const ended = transcript.find((push) => push.type === "thread.event" && push.event.type === "turn_failed")
    expect(ended).toMatchObject({ event: { type: "turn_failed", stopped: true } })
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    expect(messages.at(-1)?.parts).toStrictEqual([])
  })
})

it("queues a steer for an agent that cannot steer a running turn", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, streamed }) => {
    release()
    await Effect.runPromise(threads.update({ id: thread.id, provider: "opencode" }))
    await Effect.runPromise(runner.send(thread.id, "streams, then waits", []))
    await streamed
    await Effect.runPromise(runner.steer(thread.id, "change course", []))

    const queued = await Effect.runPromise(threads.get(thread.id))
    expect(queued.queue.map((message) => message.text)).toEqual(["change course"])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("sends the agent the document guide while the transcript keeps the typed command", async () => {
  await withPreparingThread(async ({ runner, thread, release, idle, turns, storedMessages }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "/document accepted input", []))
    await idle
    expect(turns.map((turn) => turn.input.prompt)).toStrictEqual([expandDocumentCommand("/document accepted input")])
    expect(turns[0]?.input.prompt).toContain(CHART_GUIDE)
    expect((await storedMessages(thread.id)).find((message) => message.role === "user")).toMatchObject({
      parts: [{ type: "text", text: "/document accepted input" }],
    })
    expect(await Effect.runPromise(runner.listCommands(thread.id))).toContainEqual(DOCUMENT_COMMAND)
  })
})

it("expands the document command in a steer", async () => {
  await withPreparingThread(async ({ runner, thread, release, streamed, steers }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "streams, then waits", []))
    await streamed
    await Effect.runPromise(runner.steer(thread.id, "/document the result", []))
    expect(steers).toStrictEqual([{ text: expandDocumentCommand("/document the result"), priority: "now" }])
  })
})

it("keeps the text streamed before a steer in the reply the steer closes", async () => {
  await withPreparingThread(async ({ runner, thread, release, streamed, transcript, steers }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "streams, then waits", []))
    await streamed
    await Effect.runPromise(runner.steer(thread.id, "change course", []))
    expect(steers).toStrictEqual([{ text: "change course", priority: "now" }])

    const closed = transcript.findLast((push) => push.type === "message.updated")
    expect(closed).toMatchObject({
      type: "message.updated",
      message: { role: "assistant", parts: [{ type: "text", text: streamedWords.join("") }] },
    })
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    expect(messages.map((message) => [message.role, message.parts])).toEqual([
      ["user", [{ type: "text", text: "streams, then waits" }]],
      ["assistant", [{ type: "text", text: streamedWords.join("") }]],
      ["user", [{ type: "text", text: "change course" }]],
      ["assistant", []],
    ])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("reads a running tool call's output only from the message that holds it", async () => {
  await withPreparingThread(async ({ runner, thread, release, streamed }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "calls a tool, then waits", []))
    await streamed
    await Effect.runPromise(runner.steer(thread.id, "change course", []))
    const { messages } = await Effect.runPromise(runner.transcript(thread.id))
    const [, calling, , reply] = messages
    const toolOutput = (messageId: string | undefined) =>
      Effect.runPromise(
        runner.toolOutput({ threadId: thread.id, callId: "call-1", ...(messageId && { messageId }) }).pipe(Effect.exit),
      )

    expect(await toolOutput(calling?.id)).toStrictEqual(Exit.succeed("README.md"))
    expect(await toolOutput(undefined)).toStrictEqual(Exit.succeed("README.md"))
    expect(Exit.isFailure(await toolOutput(reply?.id))).toBe(true)
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

const overdue = "2020-01-01T09:00:00.000Z"
const later = "2999-01-01T09:00:00.000Z"

it("sends an overdue scheduled message and keeps the later one", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, turns }) => {
    release()
    await Effect.runPromise(runner.schedule({ threadId: thread.id, text: "tomorrow", attachments: [], sendAt: later }))
    await Effect.runPromise(runner.schedule({ threadId: thread.id, text: "now", attachments: [], sendAt: overdue }))
    expect((await Effect.runPromise(threads.get(thread.id))).scheduled.map((message) => message.text)).toEqual([
      "now",
      "tomorrow",
    ])

    await Effect.runPromise(runner.sendDueSchedules)

    await vi.waitFor(() => expect(turns.map((turn) => turn.input.prompt)).toEqual(["now"]))
    expect((await Effect.runPromise(threads.get(thread.id))).scheduled).toStrictEqual([
      { id: expect.any(String), text: "tomorrow", attachments: [], sendAt: later },
    ])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("sends a scheduled message on its own once it comes due", async () => {
  await withPreparingThread(async ({ runner, thread, release, turns, nextTurn }) => {
    release()
    const sent = nextTurn()
    await Effect.runPromise(runner.schedule({ threadId: thread.id, text: "now", attachments: [], sendAt: overdue }))

    await sent
    expect(turns.map((turn) => turn.input.prompt)).toEqual(["now"])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("resumes a limited thread on its own once its reset passes", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, turns, nextTurn }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "streams a reply", []))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))
    const resumed = nextTurn()
    await Effect.runPromise(
      threads.update({
        id: thread.id,
        status: "limited",
        usageLimit: { kind: "usage", message: "limited", reset: { at: overdue, autoResume: true } },
      }),
    )

    await resumed
    expect(turns).toHaveLength(2)
    expect(turns[1]?.input.prompt).toMatch(/streams a reply$/)
    expect((await Effect.runPromise(threads.get(thread.id))).usageLimit?.reset?.autoResume).not.toBe(true)
  })
})

const queuedAfter = async ({ runner, threads, thread }: Probe, queue: Thread["queue"]) => {
  await Effect.runPromise(threads.update({ id: thread.id, queue }))
  await Effect.runPromise(runner.send(thread.id, "first accepted input", []))
}

it("drops a queued message the transcript got before it started, and starts the next one", async () => {
  await withPreparingThread(async (probe) => {
    const { threads, thread, release, turns, storedMessages, recordAfterCheck } = probe
    release()
    const now = new Date(0).toISOString()
    recordAfterCheck({
      id: "already-sent",
      threadId: thread.id,
      role: "user",
      parts: [{ type: "text", text: "already sent accepted input" }],
      createdAt: now,
      completedAt: now,
      usage: null,
      forkPoint: null,
    })

    await queuedAfter(probe, [
      { id: "already-sent", text: "already sent accepted input", attachments: [] },
      { id: "waiting", text: "waiting accepted input", attachments: [] },
    ])

    await vi.waitFor(() => expect(turns.map(({ input }) => input.prompt)).toContain("waiting accepted input"))
    expect((await Effect.runPromise(threads.get(thread.id))).queue).toStrictEqual([])
    expect((await storedMessages(thread.id)).filter((message) => message.id === "already-sent")).toHaveLength(1)
  })
})

it("keeps a queued message stored until its turn starts it, so a quit before then cannot lose it", async () => {
  await withPreparingThread(async (probe) => {
    const { runner, threads, thread, release, turns, storedMessages } = probe
    release()
    const finishing = probe.pauseNextUpdate()
    await queuedAfter(probe, [{ id: "waiting", text: "keeps running", attachments: [] }])
    await finishing.reached
    probe.pauseSnapshot()
    finishing.resume()
    await probe.snapshotting

    const beforeStart = {
      queued: (await Effect.runPromise(threads.get(thread.id))).queue.map((message) => message.id),
      recorded: (await storedMessages(thread.id)).filter((message) => message.id === "waiting").length,
    }
    expect(beforeStart).toStrictEqual({ queued: ["waiting"], recorded: 0 })

    probe.snapshot()
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    const whileRunning = {
      queued: (await Effect.runPromise(threads.get(thread.id))).queue.map((message) => message.id),
      recorded: (await storedMessages(thread.id)).filter((message) => message.id === "waiting").length,
    }
    expect(whileRunning).toStrictEqual({ queued: [], recorded: 1 })
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("writes nothing for a queued message whose turn failed to start, and keeps it queued", async () => {
  await withPreparingThread(async (probe) => {
    const { threads, thread, release, storedMessages, failNextInsert } = probe
    release()
    let assistants = 0
    failNextInsert((message) => message.role === "assistant" && ++assistants === 2)

    await queuedAfter(probe, [{ id: "retry-me", text: "retry me accepted input", attachments: [] }])

    await vi.waitFor(async () => {
      expect(assistants).toBe(2)
      expect((await Effect.runPromise(threads.get(thread.id))).queue.map((message) => message.id)).toEqual(["retry-me"])
    })
    expect((await storedMessages(thread.id)).some((message) => message.id === "retry-me")).toBe(false)
  })
})

it("queues a scheduled message that comes due during a turn", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, streamed }) => {
    release()
    await Effect.runPromise(runner.send(thread.id, "streams, then waits", []))
    await streamed
    await Effect.runPromise(runner.schedule({ threadId: thread.id, text: "next", attachments: [], sendAt: overdue }))

    await Effect.runPromise(runner.sendDueSchedules)

    await vi.waitFor(async () => {
      const current = await Effect.runPromise(threads.get(thread.id))
      expect(current.scheduled).toStrictEqual([])
      expect(current.queue.map((message) => message.text)).toEqual(["next"])
    })
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("keeps a scheduled message that failed to send, with the reason, until it is rescheduled", async () => {
  await withPreparingThread(async ({ runner, threads, worktrees, thread, release, turns }) => {
    release()
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(worktrees.get(thread.worktreeId!))).status).toBe("ready"),
    )
    const { path } = await Effect.runPromise(worktrees.get(thread.worktreeId!))
    rmSync(path, { recursive: true, force: true })
    await Effect.runPromise(runner.schedule({ threadId: thread.id, text: "lost", attachments: [], sendAt: overdue }))

    await Effect.runPromise(runner.sendDueSchedules)

    await vi.waitFor(async () =>
      expect((await Effect.runPromise(threads.get(thread.id))).scheduled).toMatchObject([
        { text: "lost", sendAt: overdue, failure: expect.any(String) },
      ]),
    )
    await Effect.runPromise(runner.sendDueSchedules)
    const [failed] = (await Effect.runPromise(threads.get(thread.id))).scheduled
    expect(turns).toStrictEqual([])

    await Effect.runPromise(runner.reschedule(thread.id, failed!.id, later))
    expect((await Effect.runPromise(threads.get(thread.id))).scheduled).toStrictEqual([
      { id: failed!.id, text: "lost", attachments: [], sendAt: later },
    ])
    expect(await Effect.runPromise(runner.unschedule(thread.id, failed!.id))).toMatchObject({ text: "lost" })
    expect((await Effect.runPromise(threads.get(thread.id))).scheduled).toStrictEqual([])
  })
})

it("keeps a scheduled message stored until its turn starts, and sends it once", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, waiting, turns }) => {
    await Effect.runPromise(
      runner.schedule({ threadId: thread.id, text: "keep this", attachments: [], sendAt: overdue }),
    )
    const delivery = Effect.runPromise(runner.sendDueSchedules)
    await waiting

    expect((await Effect.runPromise(threads.get(thread.id))).scheduled.map((message) => message.text)).toEqual([
      "keep this",
    ])

    release()
    await delivery
    await vi.waitFor(() => expect(turns.map((turn) => turn.input.prompt)).toEqual(["keep this"]))
    expect((await Effect.runPromise(threads.get(thread.id))).scheduled).toStrictEqual([])
    await Effect.runPromise(runner.interrupt(thread.id))
  })
})

it("delivers another thread's newly due message while a worktree is still preparing", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, waiting, turns }) => {
    await Effect.runPromise(
      runner.schedule({ threadId: thread.id, text: "wait for setup", attachments: [], sendAt: overdue }),
    )
    try {
      await waiting
      const other = await Effect.runPromise(
        threads.create({ projectId: thread.projectId, title: "Independent", provider: "claude", model: "test" }),
      )
      await Effect.runPromise(
        runner.schedule({ threadId: other.id, text: "ready now", attachments: [], sendAt: overdue }),
      )

      await vi.waitFor(() => expect(turns.map((turn) => turn.input.prompt)).toEqual(["ready now"]), { timeout: 5000 })
      expect((await Effect.runPromise(threads.get(thread.id))).scheduled.map((message) => message.text)).toEqual([
        "wait for setup",
      ])

      release()
      await vi.waitFor(() => expect(turns.map((turn) => turn.input.prompt)).toEqual(["ready now", "wait for setup"]), {
        timeout: 5000,
      })
      await Effect.runPromise(runner.interrupt(other.id))
    } finally {
      release()
      await Effect.runPromise(runner.interrupt(thread.id))
    }
  })
})

it("does not send a scheduled message again when a crash left it stored after its turn started", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, turns, storedMessages }) => {
    release()
    await Effect.runPromise(
      runner.schedule({ threadId: thread.id, text: "waits for Stop", attachments: [], sendAt: overdue }),
    )
    const stored = (await Effect.runPromise(threads.get(thread.id))).scheduled

    await Effect.runPromise(runner.sendDueSchedules)
    await vi.waitFor(() => expect(turns.map((turn) => turn.input.prompt)).toEqual(["waits for Stop"]))
    await Effect.runPromise(runner.interrupt(thread.id))
    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))

    await Effect.runPromise(threads.update({ id: thread.id, scheduled: stored }))
    await Effect.runPromise(runner.sendDueSchedules)

    await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).scheduled).toStrictEqual([]))
    expect((await Effect.runPromise(threads.get(thread.id))).queue).toStrictEqual([])
    expect(turns.map((turn) => turn.input.prompt)).toEqual(["waits for Stop"])
    expect((await storedMessages(thread.id)).filter((message) => message.role === "user")).toHaveLength(1)
  })
})

it("cancels a scheduled message that is waiting on its worktree", async () => {
  await withPreparingThread(async ({ runner, threads, thread, release, waiting, turns }) => {
    await Effect.runPromise(
      runner.schedule({ threadId: thread.id, text: "never mind", attachments: [], sendAt: overdue }),
    )
    void Effect.runPromise(runner.sendDueSchedules)
    await waiting

    const cancelled = await Effect.runPromise(
      runner.unschedule(thread.id, (await Effect.runPromise(threads.get(thread.id))).scheduled[0]!.id),
    )
    release()

    expect(cancelled).toMatchObject({ text: "never mind" })
    expect((await Effect.runPromise(threads.get(thread.id))).scheduled).toStrictEqual([])
    expect(turns).toStrictEqual([])
  })
})

const fakeClaudeCli = Layer.effect(
  ClaudeProvider,
  Effect.map(
    makeClaudeHarness({ id: "claude", listModels: Effect.succeed([]), launchEnv: () => Effect.succeed({}) }),
    (harness) =>
      ClaudeProvider.of({
        ...harness,
        account: () => Effect.succeed({ type: "apiKey" }),
        planLimits: () => Effect.succeed(null),
      }),
  ),
)

const fakeClaudeHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "kk-runner-claude-home-"))
  const binary = join(dir, "claude")
  const cli = join(import.meta.dirname, "../agents/claude/fakeCli.mjs")
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`)
  chmodSync(binary, 0o755)
  return { dir, binary }
}

const assistantText = (message: Message | undefined) =>
  message?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

it("starts a new Claude session when the CLI no longer has the thread's session", async () => {
  const home = fakeClaudeHome()
  await withPreparingThread(
    async ({ runner, threads, accounts, thread, release, storedMessages }) => {
      release()
      const account = await Effect.runPromise(
        accounts.create({ provider: "claude", name: "Fake", configDir: home.dir, binary: home.binary }),
      )
      await Effect.runPromise(threads.update({ id: thread.id, accountId: account.id, providerSessionId: "gone" }))
      const lastReply = async () =>
        (await storedMessages(thread.id)).findLast((message) => message.role === "assistant")
      const settled = async () => {
        await vi.waitFor(async () => expect((await lastReply())?.completedAt).not.toBeNull(), { timeout: 15_000 })
        return lastReply()
      }

      await Effect.runPromise(runner.send(thread.id, "hello", []))
      expect(assistantText(await settled())).toContain("starts a new Claude session")
      expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).toBeNull()

      await vi.waitFor(() => Effect.runPromise(runner.send(thread.id, "hello again", [])))
      expect(assistantText(await settled())).toMatch(/^echo: <conversation_handoff>.*hello again$/s)
      expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).not.toBeNull()
    },
    { claude: fakeClaudeCli },
  )
}, 30_000)

it("starts a fresh process when a lost session leaves its CLI running", async () => {
  const home = fakeClaudeHome()
  await withPreparingThread(
    async ({ runner, threads, accounts, thread, release, storedMessages }) => {
      release()
      const account = await Effect.runPromise(
        accounts.create({ provider: "claude", name: "Fake", configDir: home.dir, binary: home.binary }),
      )
      await Effect.runPromise(threads.update({ id: thread.id, accountId: account.id }))
      const replyMatching = (pattern: RegExp) =>
        vi.waitFor(
          async () =>
            expect(
              assistantText((await storedMessages(thread.id)).findLast((message) => message.role === "assistant")),
            ).toMatch(pattern),
          { timeout: 15_000 },
        )

      await Effect.runPromise(runner.send(thread.id, "hello", []))
      await replyMatching(/^echo: hello$/)
      const sessionId = (await Effect.runPromise(threads.get(thread.id))).providerSessionId
      rmSync(join(home.dir, "sessions", sessionId!), { force: true })
      await Effect.runPromise(runner.send(thread.id, "exit", []))
      await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))
      writeFileSync(join(home.dir, "control.json"), JSON.stringify({ lingerAfterLostSession: true }))

      await Effect.runPromise(runner.send(thread.id, "again", []))
      await replyMatching(/starts a new Claude session/)
      expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).toBeNull()

      await vi.waitFor(() => Effect.runPromise(runner.send(thread.id, "fresh", [])))
      await replyMatching(/^echo: <conversation_handoff>[\s\S]*fresh$/)
      expect(existsSync(join(home.dir, "reused.txt"))).toBe(false)
      expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).not.toBeNull()
    },
    { claude: fakeClaudeCli },
  )
}, 30_000)

it("clears the stored session when Stop is followed by a lost session", async () => {
  const home = fakeClaudeHome()
  await withPreparingThread(
    async ({ runner, threads, accounts, thread, release, storedMessages }) => {
      release()
      const account = await Effect.runPromise(
        accounts.create({ provider: "claude", name: "Fake", configDir: home.dir, binary: home.binary }),
      )
      await Effect.runPromise(threads.update({ id: thread.id, accountId: account.id }))
      const replyMatching = (pattern: RegExp) =>
        vi.waitFor(
          async () =>
            expect(
              assistantText((await storedMessages(thread.id)).findLast((message) => message.role === "assistant")),
            ).toMatch(pattern),
          { timeout: 15_000 },
        )

      await Effect.runPromise(runner.send(thread.id, "lose session on stop", []))
      await vi.waitFor(async () =>
        expect((await Effect.runPromise(runner.transcript(thread.id))).approvals).toHaveLength(1),
      )
      await Effect.runPromise(runner.interrupt(thread.id))
      await vi.waitFor(async () => expect((await Effect.runPromise(threads.get(thread.id))).status).toBe("idle"))
      expect((await Effect.runPromise(threads.get(thread.id))).providerSessionId).toBeNull()

      await vi.waitFor(() => Effect.runPromise(runner.send(thread.id, "after stop", [])))
      await replyMatching(/^echo: <conversation_handoff>[\s\S]*after stop$/)
    },
    { claude: fakeClaudeCli },
  )
}, 30_000)
