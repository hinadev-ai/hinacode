import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, layer } from "@effect/vitest"
import { Effect, Layer, Queue, Stream } from "effect"
import { unlistedModel } from "../../shared/agent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { seedThread } from "../db/testing.ts"
import { makeTestAppLayer } from "../testing.ts"
import { ArtifactFeedback } from "./ArtifactFeedback.ts"
import { Artifacts } from "./Artifacts.ts"
import { Events, PushBroadcast, WindowPush } from "./Events.ts"

const base = mkdtempSync(join(tmpdir(), "kk-artifact-feedback-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const newThread = Effect.suspend(() => seedThread({ rootPath: mkdtempSync(join(base, "project-")) })).pipe(
  Effect.map(({ threadId }) => threadId),
)

const delivered = Effect.runSync(Queue.unbounded<{ readonly threadId: string; readonly text: string }>())
const receive = (threadId: string, text: string) => Queue.offer(delivered, { threadId, text }).pipe(Effect.asVoid)

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: (input) => Stream.fromEffect(receive(input.threadId, input.prompt)).pipe(Stream.drain),
  steer: receive,
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
)

const quietEvents = Layer.mergeAll(
  Layer.succeed(Events, Events.of({ publish: () => Effect.void })),
  Layer.succeed(WindowPush, WindowPush.of({ send: () => Effect.void })),
  Layer.succeed(PushBroadcast, PushBroadcast.of({ subscribe: () => Effect.void })),
)

layer(makeTestAppLayer(join(base, "hinacode.sqlite"), { providers, events: quietEvents }), {
  excludeTestServices: true,
})("ArtifactFeedback", (it) => {
  it.effect("saves a developer comment and steers the owner, or the threads it mentions", () =>
    Effect.gen(function* () {
      const owner = yield* newThread
      const other = yield* newThread
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
        body: `@thread:${other} and @thread:gone, what do you think?`,
      })
      expect(asked.comments[0]?.messages).toHaveLength(2)
      const mentioned = yield* Queue.take(delivered)
      expect(mentioned.threadId).toBe(other)
      expect(mentioned.text).toMatch(/^Reply on document "Release Plan"[\s\S]*You were mentioned\./)
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

  it.effect("saves a verdict for the current version and tells the owner", () =>
    Effect.gen(function* () {
      const owner = yield* newThread
      const { store } = yield* Artifacts
      const verification = yield* Effect.promise(() =>
        store.publish({
          kind: "verify",
          title: "Settings page",
          threadId: owner,
          spec: { expected: [], actual: [{ path: "actual/1.png" }] },
          files: [{ path: "actual/1.png", content: "iVBORw==", encoding: "base64" }],
        }),
      )

      const decided = yield* ArtifactFeedback.use((feedback) =>
        feedback.decide({ id: verification.id, version: 1, decision: "reject", reason: "The spacing is off." }),
      )

      expect(decided.verdicts.map((verdict) => verdict.decision)).toEqual(["reject"])
      expect(yield* Queue.take(delivered)).toEqual({
        threadId: owner,
        text: `Verification "Settings page" v1: rejected. The spacing is off.\n\nFix it, then call request_verification again with id "${verification.id}".`,
      })
      const stale = yield* ArtifactFeedback.use((feedback) =>
        Effect.flip(feedback.decide({ id: verification.id, version: 2, decision: "pass", reason: "" })),
      )
      expect(stale.message).toMatch(/is at version 1, not 2/)
    }),
  )
})
