import { describe, expect, it } from "@effect/vitest"
import { describeScene } from "@hinacode/artifacts"
import { Deferred, Effect, Stream } from "effect"
import type { AgentEvent } from "../../../shared/agent.ts"
import type { ArtifactComment, CommentAnchor } from "../../../shared/artifact.ts"
import { artifactFeedbackPrompt } from "../../../shared/artifactFeedback.ts"
import { commentSteps, QUESTION_QUOTE, whiteboardSteps } from "./fixtures/feedback.ts"
import {
  approvals,
  compaction,
  everything,
  failure,
  finished,
  stoppable,
  thinkingStream,
  toolKinds,
  toolStates,
} from "./fixtures/transcript.ts"
import { scenarioOf } from "./mock.ts"
import { type ApprovalReply, type McpResult, type MockStep, play, type PlayControls } from "./play.ts"

const controls = (overrides: Partial<PlayControls> = {}): PlayControls => ({
  threadId: "thread-1",
  stopped: Deferred.makeUnsafe<void>(),
  sleep: () => Effect.void,
  approve: () => Effect.succeed({ decision: "allow" }),
  answer: () => Effect.void,
  callTool: () => Effect.succeed({ output: "Published artifact mock-1 version 1", isError: false }),
  ...overrides,
})

const run = (steps: ReadonlyArray<MockStep>, overrides?: Partial<PlayControls>) =>
  Stream.runCollect(play(steps, controls(overrides)))

const finishedCalls = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => (event.type === "tool_call_finished" ? [event] : []))

describe("play", () => {
  it.effect("ends every completing scenario with one turn_completed and no running tool", () =>
    Effect.gen(function* () {
      for (const steps of [everything, toolKinds, toolStates, thinkingStream, compaction, approvals]) {
        const events = yield* run([...steps(), finished()])
        const started = events.flatMap((event) => (event.type === "tool_call_started" ? [event.callId] : []))
        expect(
          finishedCalls(events)
            .map((event) => event.callId)
            .toSorted(),
        ).toEqual(started.toSorted())
        expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1)
        expect(events.at(-1)?.type).toBe("turn_completed")
      }
    }),
  )

  it.effect("finishes a denied tool call with the user's note as an error", () =>
    Effect.gen(function* () {
      const replies: Array<ApprovalReply> = [
        { decision: "allow" },
        { decision: "deny", note: "not on prod" },
        { decision: "allow_for_session" },
        { decision: "deny" },
      ]
      const events = yield* run(approvals(), { approve: () => Effect.succeed(replies.shift()!) })
      const results = finishedCalls(events).map(({ output, isError }) => ({ isError, output }))
      expect(results).toEqual([
        { isError: false, output: "Packages: +412\nDone in 3.2s using pnpm v10.12.1" },
        { isError: true, output: "The user denied this tool call and said: not on prod" },
        { isError: false, output: "The latest version is 8.1.0." },
        { isError: true, output: "The user denied this tool call" },
      ])
      const requested = events.flatMap((event) => (event.type === "approval_requested" ? [event.request.id] : []))
      const resolved = events.flatMap((event) => (event.type === "approval_resolved" ? [event.requestId] : []))
      expect(resolved).toEqual(requested)
      expect(events.filter((event) => event.type === "file_changed")).toEqual([])
    }),
  )

  it.effect("fails the turn with the API error", () =>
    Effect.gen(function* () {
      const events = yield* run(failure())
      expect(events.at(-1)).toMatchObject({ type: "turn_failed", message: expect.stringContaining("API Error: 529") })
    }),
  )

  it.effect("holds until Stop, then ends as Turn interrupted with the command still running", () =>
    Effect.gen(function* () {
      const stopped = Deferred.makeUnsafe<void>()
      yield* Deferred.succeed(stopped, undefined)
      const events = yield* run(stoppable(), { stopped })
      expect(events.at(-1)).toEqual({ type: "turn_failed", message: "Turn interrupted" })
      expect(finishedCalls(events)).toEqual([])
    }),
  )

  it.effect("reports a sub-agent from the SDK task messages", () =>
    Effect.gen(function* () {
      const events = yield* run(toolKinds())
      const statuses = events.flatMap((event) => (event.type === "subagent_updated" ? [event.subagent.status] : []))
      expect(statuses).toEqual(["running", "completed"])
      const nested = events.filter((event) => event.type === "tool_call_started" && event.parentCallId !== undefined)
      expect(nested).toHaveLength(2)
    }),
  )
})

const toolOutputs: Record<string, string> = {
  publish_document: 'Published document doc-1 version 1: "Rollout Plan".',
  publish_whiteboard: 'Published whiteboard board-1 version 2: "Feedback Loop".',
  comment_on_artifact: "Replied on comment c_1 of artifact doc-1.",
}

const playFeedback = (steps: ReadonlyArray<MockStep>) => {
  const calls: Array<{ readonly name: string; readonly input: Record<string, unknown> }> = []
  const callTool = (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input })
    return Effect.succeed<McpResult>({ output: toolOutputs[name] ?? "", isError: false })
  }
  return run([...steps, finished()], { callTool }).pipe(Effect.map((events) => ({ events, calls })))
}

const developerComment = (anchor: CommentAnchor, body: string): ArtifactComment => ({
  id: "c_1",
  anchor,
  resolved: false,
  messages: [{ id: "m_1", author: { kind: "developer" }, body, createdAt: "2026-11-08T09:00:00.000Z" }],
  createdAt: "2026-11-08T09:00:00.000Z",
  updatedAt: "2026-11-08T09:00:00.000Z",
})

const wholeArtifactComment = (kind: "document" | "whiteboard") =>
  artifactFeedbackPrompt({
    artifact: { id: "a-1", kind, title: "Plan" },
    comment: developerComment({ kind: "artifact" }, "Why?"),
  })

describe("feedback scenarios", () => {
  it.effect("publishes a document, then asks about a quote in it", () =>
    Effect.gen(function* () {
      const { events, calls } = yield* playFeedback(commentSteps("/mock-comments Rollout Plan"))
      expect(calls).toEqual([
        {
          name: "publish_document",
          input: expect.objectContaining({ title: "Rollout Plan", markdown: expect.stringContaining(QUESTION_QUOTE) }),
        },
        { name: "comment_on_artifact", input: expect.objectContaining({ id: "doc-1", quote: QUESTION_QUOTE }) },
      ])
      expect(finishedCalls(events)).toHaveLength(2)
      expect(events.at(-1)?.type).toBe("turn_completed")
    }),
  )

  it.effect("answers a document comment on its comment id", () =>
    Effect.gen(function* () {
      const steer = artifactFeedbackPrompt({
        artifact: { id: "doc-1", kind: "document", title: "Rollout (Plan)" },
        comment: developerComment({ kind: "text", quote: "the deploy", prefix: "", suffix: "" }, "Move it?"),
      })
      const { calls } = yield* playFeedback(commentSteps(steer))
      expect(calls).toEqual([
        { name: "comment_on_artifact", input: expect.objectContaining({ id: "doc-1", comment: "c_1" }) },
      ])
    }),
  )

  it.effect("adds a note to the right of the elements a whiteboard question is about", () =>
    Effect.gen(function* () {
      const steer = artifactFeedbackPrompt({
        artifact: { id: "board-1", kind: "whiteboard", title: "Feedback Loop" },
        comment: developerComment({ kind: "elements", ids: ["box"] }, "What goes here?"),
        elements: describeScene([{ id: "box", type: "rectangle", x: 100, y: 200, width: 150, height: 60 }]),
      })
      const { calls } = yield* playFeedback(whiteboardSteps(steer))
      expect(calls.map((call) => call.name)).toEqual(["publish_whiteboard", "comment_on_artifact"])
      expect(calls[0]?.input).toMatchObject({ id: "board-1", elements: [{ id: "note-c_1", x: 290, y: 200 }] })
      expect(calls[1]?.input).toMatchObject({ id: "board-1", comment: "c_1" })
    }),
  )
})

describe("scenarioOf", () => {
  it("picks the scenario a /mock- command names", () => {
    expect(scenarioOf("/mock-tool-states", "usage-limit")).toBe("tool-states")
    expect(scenarioOf("  /mock-everything please", "usage-limit")).toBe("everything")
  })

  it("routes a feedback message to the scenario that answers it", () => {
    expect(scenarioOf(wholeArtifactComment("document"), "whiteboard")).toBe("comments")
    expect(scenarioOf(wholeArtifactComment("whiteboard"), "comments")).toBe("whiteboard")
  })

  it("falls back to the launch scenario for any other prompt", () => {
    expect(scenarioOf("fix the login bug", "todos")).toBe("todos")
    expect(scenarioOf("/mock-nope", "todos")).toBe("todos")
    expect(scenarioOf("see /mock-tools", "todos")).toBe("todos")
  })
})
