import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { type AgentEvent, unlistedModel } from "../../shared/agent.ts"
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
const stops = new Map<string, Deferred.Deferred<void>>()

const untilStopped = (threadId: string) => {
  const stop = Deferred.makeUnsafe<void>()
  stops.set(threadId, stop)
  return Stream.fromEffect(Deferred.await(stop)).pipe(
    Stream.as<AgentEvent>({ type: "turn_failed", message: "Stopped", stopped: true }),
  )
}

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: ({ threadId, prompt }) =>
    Stream.fromEffect(Queue.offer(starts, { threadId, prompt })).pipe(
      Stream.drain,
      Stream.concat(Stream.suspend(() => untilStopped(threadId))),
    ),
  interrupt: (threadId) => Deferred.succeed(stops.get(threadId)!, undefined).pipe(Effect.asVoid),
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

const quietEvents = Layer.mergeAll(
  Layer.succeed(Events, Events.of({ publish: () => Effect.void })),
  Layer.succeed(WindowPush, WindowPush.of({ send: () => Effect.void })),
  Layer.succeed(PushBroadcast, PushBroadcast.of({ subscribe: () => Effect.void })),
)

const appOn = (dbPath: string) => makeTestAppLayer(dbPath, { providers, events: quietEvents })

const statuses = Threads.use((threads) => threads.list).pipe(
  Effect.map((list) => Object.fromEntries(list.map((thread) => [thread.id, thread.status]))),
)

const sendAndWaitForStart = (threadId: string) =>
  Effect.gen(function* () {
    yield* AgentRunner.use((runner) => runner.send(threadId, "Say hi", []))
    return yield* Queue.take(starts)
  })

const PARALLEL_THREADS = 24

it.live(
  "a restart after an OOM kill marks all 24 busy threads interrupted, and no later start resumes them",
  () =>
    Effect.gen(function* () {
      const dbPath = join(mkdtempSync(join(base, "oom-")), "hinacode.sqlite")
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
        expect(yield* statuses).toStrictEqual({
          ...Object.fromEntries(crashed.map((id) => [id, "interrupted"])),
          [control]: "idle",
        })
        expect(yield* Queue.size(starts)).toBe(0)
        expect((yield* Threads.use((threads) => threads.get(untouched[0]!))).snoozedUntil).toBeNull()

        yield* AgentRunner.use((runner) => runner.resume(resumed!))
        expect(yield* Queue.take(starts)).toStrictEqual({ threadId: resumed, prompt: RESUME_PROMPT })
        expect(yield* Queue.size(starts)).toBe(0)
        const after = yield* statuses
        expect(after[resumed!]).toBe("running")
        expect(untouched.map((id) => after[id])).toStrictEqual(untouched.map(() => "interrupted"))
      }).pipe(Effect.provide(appOn(dbPath)))

      yield* Effect.gen(function* () {
        expect(yield* statuses).toStrictEqual({
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
    const dbPath = join(mkdtempSync(join(base, "stop-")), "hinacode.sqlite")
    const { threadId } = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) }).pipe(
      Effect.provide(appOn(dbPath)),
    )

    yield* Effect.gen(function* () {
      yield* sendAndWaitForStart(threadId)
      yield* AgentRunner.use((runner) => runner.stop(threadId))
    }).pipe(Effect.provide(appOn(dbPath)))

    const status = yield* statuses.pipe(Effect.provide(appOn(dbPath)))
    expect(status[threadId]).toBe("idle")
  }),
)

it.live("refuses to resume a thread that was not interrupted", () =>
  Effect.gen(function* () {
    const dbPath = join(mkdtempSync(join(base, "refuse-")), "hinacode.sqlite")
    yield* Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: mkdtempSync(join(base, "project-")) })
      const refused = yield* AgentRunner.use((runner) => runner.resume(threadId)).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "AgentError", message: "This thread was not interrupted" })
      expect(yield* Queue.size(starts)).toBe(0)
    }).pipe(Effect.provide(appOn(dbPath)))
  }),
)
