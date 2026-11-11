import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it as vitest, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from "effect"
import { unlistedModel } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { AgentError, type AgentProvider } from "../agents/provider.ts"
import { seedThread } from "../db/testing.ts"
import { makeTestAppLayer } from "../testing.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { ArtifactFeedback } from "./ArtifactFeedback.ts"
import { Artifacts } from "./Artifacts.ts"
import { Events, PushBroadcast, WindowPush } from "./Events.ts"
import { Threads } from "./Threads.ts"

const base = mkdtempSync(join(tmpdir(), "kk-artifact-feedback-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const newThread = Effect.suspend(() => seedThread({ rootPath: mkdtempSync(join(base, "project-")) })).pipe(
  Effect.map(({ threadId }) => threadId),
)

const documentOf = (threadId: string) =>
  Artifacts.use(({ store }) =>
    Effect.promise(() => store.publish({ kind: "document", title: "Plan", markdown: "Ship it.", threadId })),
  )

const ownerAndSibling = Effect.gen(function* () {
  const rootPath = mkdtempSync(join(base, "project-"))
  const { projectId, threadId: owner } = yield* seedThread({ rootPath })
  const { threadId: sibling } = yield* seedThread({ rootPath, projectId })
  return { owner, sibling }
})

const delivered = Effect.runSync(Queue.unbounded<{ readonly threadId: string; readonly text: string }>())
const receive = (threadId: string, text: string) => Queue.offer(delivered, { threadId, text }).pipe(Effect.asVoid)

const KEEP_WORKING = "Keep working until I stop you."
const STALLS_STEER = "This steer never returns."
const REFUSES_STEER = "This steer fails, so it waits in the queue."
const stalledSteer = Effect.runSync(Deferred.make<void>())

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: (input) =>
    Stream.fromEffect(receive(input.threadId, input.prompt)).pipe(
      Stream.drain,
      Stream.concat(input.prompt === KEEP_WORKING ? Stream.never : Stream.empty),
    ),
  steer: (threadId, text) => {
    if (text.includes(STALLS_STEER)) return Deferred.succeed(stalledSteer, undefined).pipe(Effect.andThen(Effect.never))
    if (text.includes(REFUSES_STEER)) return Effect.fail(new AgentError({ provider: id, message: "steer refused" }))
    return receive(threadId, text)
  },
  interrupt: () => Effect.void,
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

const restartable = makeTestAppLayer(join(mkdtempSync(join(base, "restart-")), "hinacode.sqlite"), {
  providers,
  events: quietEvents,
})

layer(makeTestAppLayer(join(base, "hinacode.sqlite"), { providers, events: quietEvents }), {
  excludeTestServices: true,
})("ArtifactFeedback", (it) => {
  it.effect("saves a developer comment and steers the owner, or the threads it mentions in its project", () =>
    Effect.gen(function* () {
      const { owner, sibling } = yield* ownerAndSibling
      const outsider = yield* newThread
      const { store } = yield* Artifacts
      const feedback = yield* ArtifactFeedback
      const document = yield* Effect.promise(() =>
        store.publish({
          kind: "document",
          title: "Release Plan",
          markdown: "the migration runs before the deploy",
          threadId: owner,
        }),
      )

      const saved = yield* feedback.comment({
        id: document.id,
        anchor: { kind: "text", quote: "the migration runs before the deploy", prefix: "", suffix: "" },
        body: "Should this be after?",
      })
      const [comment] = saved.comments
      expect(yield* Queue.take(delivered)).toEqual({
        threadId: owner,
        text: [
          `Comment on document "Release Plan" (artifact ${document.id}, comment ${comment?.id}):`,
          "> the migration runs before the deploy",
          "Should this be after?",
          "",
          "Answer with comment_on_artifact, and change the document if needed.",
        ].join("\n"),
      })

      const asked = yield* feedback.comment({
        id: document.id,
        comment: comment?.id ?? "",
        body: `@thread:${sibling}, @thread:${outsider} and @thread:gone, what do you think?`,
      })
      expect(asked.comments[0]?.messages).toHaveLength(2)
      const mentioned = yield* Queue.take(delivered)
      expect(mentioned.threadId).toBe(sibling)
      expect(mentioned.text).toMatch(/^Reply on document "Release Plan"[\s\S]*You were mentioned\./)
      expect(yield* Queue.size(delivered)).toBe(0)

      yield* feedback.comment({ id: document.id, comment: comment?.id ?? "", body: `@thread:${outsider} thoughts?` })
      expect((yield* Queue.take(delivered)).threadId).toBe(owner)
      expect(yield* Queue.size(delivered)).toBe(0)

      const refused = yield* Effect.flip(feedback.comment({ id: document.id, comment: "c_gone", body: "Hi" }))
      expect(refused._tag).toBe("ArtifactFeedbackError")
      expect((yield* Effect.flip(feedback.feedback("gone")))._tag).toBe("NotFoundError")
    }),
  )

  it.effect("asks about selected whiteboard elements with their text", () =>
    Effect.gen(function* () {
      const owner = yield* newThread
      const { store } = yield* Artifacts
      const board = yield* Effect.promise(() =>
        store.publish({
          kind: "whiteboard",
          title: "Architecture",
          threadId: owner,
          scene: {
            elements: [
              { id: "api", type: "rectangle", x: 0, y: 0, width: 180, height: 80 },
              { id: "api-label", type: "text", text: "API", containerId: "api" },
              { id: "db", type: "ellipse", x: 300, y: 0, width: 120, height: 80 },
            ],
          },
        }),
      )

      yield* ArtifactFeedback.use((feedback) =>
        feedback.comment({ id: board.id, anchor: { kind: "elements", ids: ["api"] }, body: "Where is the cache?" }),
      )

      expect((yield* Queue.take(delivered)).text).toContain(
        'About elements api:\napi rectangle "API" at 0,0 180x80\nWhere is the cache?',
      )
    }),
  )

  it.effect("starts a turn on a settled owner", () =>
    Effect.gen(function* () {
      const owner = yield* newThread
      const document = yield* documentOf(owner)
      yield* Threads.use((threads) => threads.settle(owner))

      yield* ArtifactFeedback.use((feedback) => feedback.comment({ id: document.id, body: "Still there?" }))

      expect(yield* Queue.take(delivered)).toMatchObject({
        threadId: owner,
        text: expect.stringContaining("Still there?"),
      })
    }),
  )

  it.effect("keeps a comment on the document of a deleted thread without delivering it", () =>
    Effect.gen(function* () {
      const owner = yield* newThread
      const document = yield* documentOf(owner)
      yield* Threads.use((threads) => threads.remove(owner))

      const saved = yield* ArtifactFeedback.use((feedback) => feedback.comment({ id: document.id, body: "Anyone?" }))

      expect(saved.comments.map((comment) => comment.messages[0]?.body)).toEqual(["Anyone?"])
      expect(yield* Queue.size(delivered)).toBe(0)
    }),
  )

  it.effect("reopens an archived thread to deliver a comment, like a message from the composer", () =>
    Effect.gen(function* () {
      const owner = yield* newThread
      const threads = yield* Threads
      const document = yield* documentOf(owner)
      yield* threads.archive(owner)

      yield* ArtifactFeedback.use((feedback) => feedback.comment({ id: document.id, body: "Not yet." }))

      expect((yield* Queue.take(delivered)).threadId).toBe(owner)
      expect((yield* threads.get(owner)).status).not.toBe("archived")
    }),
  )
})

vitest.live("delivers a comment saved right before the app quit once it starts again", () =>
  Effect.gen(function* () {
    const { threadId, artifactId } = yield* Effect.gen(function* () {
      const owner = yield* newThread
      const document = yield* documentOf(owner)
      yield* AgentRunner.use((runner) => runner.send(owner, KEEP_WORKING, []))
      expect(yield* Queue.take(delivered)).toEqual({ threadId: owner, text: KEEP_WORKING })

      const commenting = yield* ArtifactFeedback.use((feedback) =>
        feedback.comment({ id: document.id, body: STALLS_STEER }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(stalledSteer)
      yield* Fiber.interrupt(commenting)
      return { threadId: owner, artifactId: document.id }
    }).pipe(Effect.provide(restartable))

    const redelivered = yield* Effect.gen(function* () {
      const saved = yield* ArtifactFeedback.use((feedback) => feedback.feedback(artifactId))
      expect(saved.comments.map((comment) => comment.messages[0]?.body)).toEqual([STALLS_STEER])
      return yield* Queue.take(delivered).pipe(Effect.timeoutOption("5 seconds"))
    }).pipe(Effect.provide(restartable))

    expect(redelivered).toEqual(Option.some({ threadId, text: expect.stringContaining(STALLS_STEER) }))
  }),
)

vitest.live("does not deliver a comment twice when the app quit after queueing it", () =>
  Effect.gen(function* () {
    const { threadId, artifactId } = yield* Effect.gen(function* () {
      const owner = yield* newThread
      const document = yield* documentOf(owner)
      yield* AgentRunner.use((runner) => runner.send(owner, KEEP_WORKING, []))
      expect(yield* Queue.take(delivered)).toEqual({ threadId: owner, text: KEEP_WORKING })
      yield* ArtifactFeedback.use((feedback) => feedback.comment({ id: document.id, body: REFUSES_STEER }))

      const { store } = yield* Artifacts
      const file = join(store.root, document.id, "feedback.json")
      const saved = JSON.parse(readFileSync(file, "utf8"))
      saved.comments[0].messages[0].undelivered = true
      writeFileSync(file, JSON.stringify(saved))
      return { threadId: owner, artifactId: document.id }
    }).pipe(Effect.provide(restartable))

    const { redelivered, after, queue } = yield* Effect.gen(function* () {
      const redelivered = yield* Queue.take(delivered).pipe(Effect.timeoutOption("1 second"))
      const after = yield* ArtifactFeedback.use((feedback) => feedback.feedback(artifactId))
      const { queue } = yield* Threads.use((threads) => threads.get(threadId))
      return { redelivered, after, queue }
    }).pipe(Effect.provide(restartable))

    expect(redelivered).toEqual(Option.none())
    expect(queue.map((message) => message.text)).toEqual([expect.stringContaining(REFUSES_STEER)])
    expect(after.comments[0]?.messages[0]?.undelivered).toBeUndefined()
  }),
)
