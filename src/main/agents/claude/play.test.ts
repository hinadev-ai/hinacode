import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Stream } from "effect"
import type { AgentEvent } from "../../../shared/agent.ts"
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
import { type ApprovalReply, type MockStep, play, type PlayControls } from "./play.ts"

const controls = (overrides: Partial<PlayControls> = {}): PlayControls => ({
  threadId: "thread-1",
  stopped: Deferred.makeUnsafe<void>(),
  sleep: () => Effect.void,
  approve: () => Effect.succeed({ decision: "allow" }),
  answer: () => Effect.void,
  publishArtifact: () => Effect.succeed({ output: "Published artifact mock-1 version 1", isError: false }),
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

  it.effect("holds until Stop, then ends as Interrupted with the command still running", () =>
    Effect.gen(function* () {
      const stopped = Deferred.makeUnsafe<void>()
      yield* Deferred.succeed(stopped, undefined)
      const events = yield* run(stoppable(), { stopped })
      expect(events.at(-1)).toEqual({ type: "turn_failed", message: "Interrupted" })
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

describe("scenarioOf", () => {
  it("picks the scenario a /mock- command names", () => {
    expect(scenarioOf("/mock-tool-states", "usage-limit")).toBe("tool-states")
    expect(scenarioOf("  /mock-everything please", "usage-limit")).toBe("everything")
  })

  it("falls back to the launch scenario for any other prompt", () => {
    expect(scenarioOf("fix the login bug", "todos")).toBe("todos")
    expect(scenarioOf("/mock-nope", "todos")).toBe("todos")
    expect(scenarioOf("see /mock-tools", "todos")).toBe("todos")
  })
})
