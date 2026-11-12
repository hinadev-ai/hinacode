import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { type AgentEvent, unlistedModel } from "../../shared/agent.ts"
import { PushEvent, RpcMethods } from "../../shared/contract.ts"
import { isInterrupted, Thread } from "../../shared/domain.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { seedThread } from "../db/testing.ts"
import { makeTestAppLayer } from "../testing.ts"
import { AgentRunner, RESUME_PROMPT } from "./AgentRunner.ts"
import { Events, PushBroadcast, WindowPush } from "./Events.ts"
import { Messages } from "./Messages.ts"
import { Threads } from "./Threads.ts"

const base = mkdtempSync(join(tmpdir(), "kk-interrupted-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

interface Start {
  readonly threadId: string
  readonly prompt: string
}

const starts = Effect.runSync(Queue.unbounded<Start>())
const turnEnds = new Map<string, Deferred.Deferred<AgentEvent>>()
const published: PushEvent[] = []

const startTurn = (threadId: string, prompt: string) => {
  const end = Deferred.makeUnsafe<AgentEvent>()
  turnEnds.set(threadId, end)
  return Stream.fromEffect(Queue.offer(starts, { threadId, prompt })).pipe(
    Stream.as<AgentEvent>({ type: "session_bound", providerSessionId: `session-${threadId}` }),
    Stream.concat(Stream.fromEffect(Deferred.await(end))),
  )
}

const endTurn = (threadId: string, event: AgentEvent) =>
  Deferred.succeed(turnEnds.get(threadId)!, event).pipe(Effect.asVoid)

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: ({ threadId, prompt }) => Stream.suspend(() => startTurn(threadId, prompt)),
  interrupt: (threadId) => endTurn(threadId, { type: "turn_failed", message: "Stopped", stopped: true }),
  respondApproval: () => Effect.succeed(false),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, provider("claude")),
  Layer.succeed(CodexProvider, provider("codex")),
  Layer.succeed(MuseProvider, provider("muse")),
  Layer.succeed(OpencodeProvider, provider("opencode")),
  Layer.succeed(MagpieProvider, provider("magpie")),
)

const recordedEvents = Layer.mergeAll(
  Layer.succeed(Events, Events.of({ publish: (event) => Effect.sync(() => published.push(event)) })),
  Layer.succeed(WindowPush, WindowPush.of({ send: () => Effect.void })),
  Layer.succeed(PushBroadcast, PushBroadcast.of({ subscribe: () => Effect.void })),
)

const appOn = (dbPath: string) => makeTestAppLayer(dbPath, { providers, events: recordedEvents })

const freshDatabase = (name: string) => join(mkdtempSync(join(base, `${name}-`)), "hinacode.sqlite")

const states = Threads.use((threads) => threads.list).pipe(
  Effect.map((list) =>
    Object.fromEntries(list.map((thread) => [thread.id, isInterrupted(thread) ? "interrupted" : thread.status])),
  ),
)

const sendAndWaitForStart = (threadId: string) =>
  Effect.gen(function* () {
    yield* AgentRunner.use((runner) => runner.send(threadId, "Say hi", []))
    return yield* Queue.take(starts)
  })

const crashMidTurn = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE thread SET status = 'running' WHERE id = ${threadId}`
  })

const PARALLEL_THREADS = 24

it.live(
  "a restart after an OOM kill marks all 24 busy threads interrupted, and no later start resumes them",
  () =>
    Effect.gen(function* () {
      const dbPath = freshDatabase("oom")
      const rootPath = mkdtempSync(join(base, "project-"))

      const { crashed, control } = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const first = yield* seedThread({ rootPath })
        const rest = yield* Effect.forEach(Array.from({ length: PARALLEL_THREADS - 1 }), () =>
          seedThread({ rootPath, projectId: first.projectId }),
        )
        const busy = [first, ...rest].map(({ threadId }) => threadId)
        const idle = yield* seedThread({ rootPath, projectId: first.projectId })
        yield* sql`UPDATE thread SET status = 'running' WHERE id IN ${sql.in(busy.slice(0, 20))}`
        yield* sql`UPDATE thread SET status = 'awaiting_approval' WHERE id IN ${sql.in(busy.slice(20))}`
        yield* sql`UPDATE thread SET snoozed_until = '2999-01-01T00:00:00.000Z' WHERE id = ${busy[1]!}`
        return { crashed: busy, control: idle.threadId }
      }).pipe(Effect.provide(appOn(dbPath)))
      const [resumed, ...untouched] = crashed

      yield* Effect.gen(function* () {
        expect(yield* states).toStrictEqual({
          ...Object.fromEntries(crashed.map((id) => [id, "interrupted"])),
          [control]: "idle",
        })
        expect(yield* Queue.size(starts)).toBe(0)
        expect((yield* Threads.use((threads) => threads.get(untouched[0]!))).snoozedUntil).toBeNull()

        yield* AgentRunner.use((runner) => runner.resume(resumed!))
        expect(yield* Queue.take(starts)).toStrictEqual({ threadId: resumed, prompt: RESUME_PROMPT })
        expect(yield* Queue.size(starts)).toBe(0)
        const after = yield* states
        expect(after[resumed!]).toBe("running")
        expect(untouched.map((id) => after[id])).toStrictEqual(untouched.map(() => "interrupted"))
      }).pipe(Effect.provide(appOn(dbPath)))

      yield* Effect.gen(function* () {
        expect(yield* states).toStrictEqual({
          ...Object.fromEntries(crashed.map((id) => [id, "interrupted"])),
          [control]: "idle",
        })
        expect(yield* sendAndWaitForStart(control)).toStrictEqual({ threadId: control, prompt: "Say hi" })
        expect(yield* Queue.size(starts)).toBe(0)
        const messages = yield* Messages.use((stored) => stored.list(resumed!))
        expect(messages.map((message) => message.completedAt === null)).toStrictEqual([false, false])
      }).pipe(Effect.provide(appOn(dbPath)))
    }),
  { timeout: 30_000 },
)

it.live("a turn the developer stopped stays idle across a quit", () =>
  Effect.gen(function* () {
    const dbPath = freshDatabase("stop")
    const { threadId } = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) }).pipe(
      Effect.provide(appOn(dbPath)),
    )

    yield* Effect.gen(function* () {
      yield* sendAndWaitForStart(threadId)
      yield* AgentRunner.use((runner) => runner.stop(threadId))
    }).pipe(Effect.provide(appOn(dbPath)))

    const after = yield* states.pipe(Effect.provide(appOn(dbPath)))
    expect(after[threadId]).toBe("idle")
  }),
)

it.live("refuses to resume a thread that was not interrupted", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) })
      const refused = yield* AgentRunner.use((runner) => runner.resume(threadId)).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "AgentError", message: "This thread was not interrupted" })
      expect(yield* Queue.size(starts)).toBe(0)
    }).pipe(Effect.provide(appOn(freshDatabase("refuse"))))
  }),
)

it.live("keeps a crashed thread's queued message until the resumed turn ends, then starts it", () =>
  Effect.gen(function* () {
    const dbPath = freshDatabase("queue")
    const queued = [{ id: "queued-before-crash", text: "Then write the tests", attachments: [] }]
    const { threadId } = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const seeded = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) })
      yield* crashMidTurn(seeded.threadId)
      yield* sql`UPDATE thread SET queue = ${JSON.stringify(queued)} WHERE id = ${seeded.threadId}`
      return seeded
    }).pipe(Effect.provide(appOn(dbPath)))

    yield* Effect.gen(function* () {
      expect((yield* states)[threadId]).toBe("interrupted")
      expect(yield* Queue.size(starts)).toBe(0)

      yield* AgentRunner.use((runner) => runner.resume(threadId))
      expect(yield* Queue.take(starts)).toStrictEqual({ threadId, prompt: RESUME_PROMPT })
      expect((yield* Threads.use((threads) => threads.get(threadId))).queue).toStrictEqual(queued)

      yield* endTurn(threadId, { type: "turn_completed" })
      expect(yield* Queue.take(starts)).toStrictEqual({ threadId, prompt: "Then write the tests" })
      expect(yield* Queue.size(starts)).toBe(0)
    }).pipe(Effect.provide(appOn(dbPath)))
  }),
)

it.live("a scheduled message that came due starts its own turn on an interrupted thread at startup", () =>
  Effect.gen(function* () {
    const dbPath = freshDatabase("scheduled")
    const due = [
      { id: "due-during-crash", text: "Check the deploy", attachments: [], sendAt: "2026-01-01T00:00:00.000Z" },
    ]
    const { scheduled, other } = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const seeded = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) })
      const sibling = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) })
      yield* crashMidTurn(seeded.threadId)
      yield* crashMidTurn(sibling.threadId)
      yield* sql`UPDATE thread SET scheduled = ${JSON.stringify(due)} WHERE id = ${seeded.threadId}`
      return { scheduled: seeded.threadId, other: sibling.threadId }
    }).pipe(Effect.provide(appOn(dbPath)))

    yield* Effect.gen(function* () {
      expect(yield* Queue.take(starts)).toStrictEqual({ threadId: scheduled, prompt: "Check the deploy" })
      const thread = yield* Threads.use((threads) => threads.get(scheduled))
      expect(thread).toMatchObject({ status: "running", interruptedAt: null, scheduled: [] })
      expect((yield* states)[other]).toBe("interrupted")
      expect(yield* Queue.size(starts)).toBe(0)
    }).pipe(Effect.provide(appOn(dbPath)))
  }),
)

const { interruptedAt: _interruptedAt, ...threadFieldsOnMain } = Thread.fields
const ThreadOnMain = Schema.Struct({
  ...threadFieldsOnMain,
  status: Schema.Literals(["draft", "idle", "running", "awaiting_approval", "limited", "archived"]),
})
const ThreadUpdatedOnMain = Schema.Struct({ type: Schema.Literal("thread.updated"), thread: ThreadOnMain })

const overTheWire = (encoded: unknown): unknown => JSON.parse(JSON.stringify(encoded))

it.live("an older phone, peer or CLI reads an interrupted thread from the list and the push as idle", () =>
  Effect.gen(function* () {
    const dbPath = freshDatabase("compat")
    const { threadId } = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) }).pipe(
      Effect.provide(appOn(dbPath)),
    )
    published.length = 0
    yield* sendAndWaitForStart(threadId).pipe(Effect.provide(appOn(dbPath)))

    const pushed = published.findLast(
      (event): event is Extract<PushEvent, { type: "thread.updated" }> =>
        event.type === "thread.updated" && event.thread.id === threadId,
    )
    expect(pushed && isInterrupted(pushed.thread)).toBe(true)
    const push = Schema.decodeUnknownSync(ThreadUpdatedOnMain)(overTheWire(Schema.encodeSync(PushEvent)(pushed!)))
    expect(push.thread).toMatchObject({ id: threadId, status: "idle" })

    const listed = yield* Threads.use((threads) => threads.list).pipe(Effect.provide(appOn(dbPath)))
    expect(listed.find((thread) => thread.id === threadId)).toSatisfy(isInterrupted)
    const list = Schema.decodeUnknownSync(Schema.Array(ThreadOnMain))(
      overTheWire(Schema.encodeSync(RpcMethods["threads.list"].response)(listed)),
    )
    expect(list.find((thread) => thread.id === threadId)).toMatchObject({ status: "idle" })
  }),
)
