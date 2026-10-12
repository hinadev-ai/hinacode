import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, test } from "@effect/vitest"
import type { AgentEvent } from "../../../shared/agent.ts"
import { mapMessage, type MapState } from "./mapMessage.ts"

const newState = (): MapState => ({ pendingEdits: new Map(), subagents: new Map() })

// Shapes recorded from a Claude Code run that spawned two parallel sub-agents.
const started = {
  type: "system",
  subtype: "task_started",
  task_id: "abf6bab06dbff9ec1",
  run_id: "0mv4lslyh-4932a595",
  tool_use_id: "toolu_01DoGmNCXkV2M8SMNaE7E3XJ",
  description: "Count repo files",
  subagent_type: "general-purpose",
  is_backgrounded: false,
  spawn_depth: 1,
  task_type: "local_agent",
  prompt: "Count the files tracked by git.",
  uuid: "9f45d928-a60f-4059-a87f-38cc4f3cd90d",
  session_id: "ba5016ca-1ee2-487b-8b1c-bc680f339ec3",
} as const satisfies SDKMessage

const progress = {
  type: "system",
  subtype: "task_progress",
  task_id: "abf6bab06dbff9ec1",
  run_id: "0mv4lslyh-4932a595",
  tool_use_id: "toolu_01DoGmNCXkV2M8SMNaE7E3XJ",
  description: "Running Count git-tracked files in the agents-tab worktree",
  subagent_type: "general-purpose",
  usage: { total_tokens: 12515, tool_uses: 1, duration_ms: 1284 },
  last_tool_name: "Bash",
  uuid: "0bd625f0-48ff-4dab-b059-060ca8813e39",
  session_id: "ba5016ca-1ee2-487b-8b1c-bc680f339ec3",
} as const satisfies SDKMessage

const notification = {
  type: "system",
  subtype: "task_notification",
  task_id: "abf6bab06dbff9ec1",
  run_id: "0mv4lslyh-4932a595",
  tool_use_id: "toolu_01DoGmNCXkV2M8SMNaE7E3XJ",
  status: "completed",
  output_file: "/private/tmp/claude-501/tasks/abf6bab06dbff9ec1.output",
  summary: "The worktree tracks 218 files.",
  usage: { total_tokens: 14310, tool_uses: 1, duration_ms: 2507 },
  uuid: "b0134252-83f3-4fac-a686-07a780d63e16",
  session_id: "ba5016ca-1ee2-487b-8b1c-bc680f339ec3",
} as const satisfies SDKMessage

const subagentOf = (events: ReadonlyArray<AgentEvent>) => {
  expect(events).toHaveLength(1)
  const [event] = events
  if (event?.type !== "subagent_updated") throw new Error(`expected subagent_updated, got ${event?.type}`)
  return event.subagent
}

describe("mapMessage sub-agent tasks", () => {
  test("follows a sub-agent from start through progress to its final summary", () => {
    const state = newState()

    expect(subagentOf(mapMessage(started, state, "2026-10-12T10:00:00.000Z"))).toEqual({
      id: "abf6bab06dbff9ec1",
      label: "Count repo files",
      kind: "general-purpose",
      status: "running",
      summary: null,
      lastTool: null,
      toolUses: 0,
      tokens: 0,
      startedAt: "2026-10-12T10:00:00.000Z",
      endedAt: null,
    })

    expect(subagentOf(mapMessage(progress, state, "2026-10-12T10:00:01.000Z"))).toMatchObject({
      status: "running",
      summary: "Running Count git-tracked files in the agents-tab worktree",
      lastTool: "Bash",
      toolUses: 1,
      tokens: 12515,
    })

    expect(subagentOf(mapMessage(notification, state, "2026-10-12T10:00:03.000Z"))).toMatchObject({
      label: "Count repo files",
      status: "completed",
      summary: "The worktree tracks 218 files.",
      lastTool: "Bash",
      tokens: 14310,
      startedAt: "2026-10-12T10:00:00.000Z",
      endedAt: "2026-10-12T10:00:03.000Z",
    })
  })

  test("prefers the progress summary and keeps a failed or stopped status", () => {
    const state = newState()
    mapMessage(started, state, "2026-10-12T10:00:00.000Z")
    const summarized = mapMessage({ ...progress, summary: "Counting tracked files" }, state, "2026-10-12T10:00:01.000Z")
    expect(subagentOf(summarized).summary).toBe("Counting tracked files")
    const stopped = mapMessage(
      { ...notification, status: "stopped" as const, summary: "" },
      state,
      "2026-10-12T10:00:02.000Z",
    )
    expect(subagentOf(stopped)).toMatchObject({ status: "stopped", summary: "Counting tracked files" })
  })

  test("ignores shells, housekeeping tasks and progress for tasks it never saw start", () => {
    const state = newState()
    const now = "2026-10-12T10:00:00.000Z"
    expect(mapMessage({ ...started, task_type: "local_bash" }, state, now)).toEqual([])
    expect(mapMessage({ ...started, ambient: true }, state, now)).toEqual([])
    expect(mapMessage({ ...started, skip_transcript: true }, state, now)).toEqual([])
    expect(mapMessage(progress, state, now)).toEqual([])
    expect(mapMessage(notification, state, now)).toEqual([])
  })
})

const assistantWithUsage = (parentToolUseId: string | null, usage: Record<string, number>) =>
  ({
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: { model: "claude-opus-4-7", content: [{ type: "text", text: "ok" }], usage },
    uuid: "c1f4f8b2-1a7e-4c55-9d3e-0f4a1b2c3d4e",
    session_id: "ba5016ca-1ee2-487b-8b1c-bc680f339ec3",
  }) as unknown as SDKMessage

const successResult = (modelUsage: Record<string, { contextWindow: number }>) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.5,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    modelUsage,
  }) as unknown as SDKMessage

const completedUsage = (events: ReadonlyArray<AgentEvent>) => {
  const [event] = events
  if (event?.type !== "turn_completed") throw new Error(`expected turn_completed, got ${event?.type}`)
  return event.usage
}

describe("mapMessage context window", () => {
  const now = "2026-10-12T10:00:00.000Z"

  test("reports the main loop's latest request against the model's context window", () => {
    const state = newState()
    const main = {
      input_tokens: 1_000,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 40_000,
      output_tokens: 500,
    }
    const subagent = {
      input_tokens: 90_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 9_000,
    }
    mapMessage(assistantWithUsage(null, main), state, now)
    mapMessage(assistantWithUsage("toolu_01DoGmNCXkV2M8SMNaE7E3XJ", subagent), state, now)
    const result = successResult({ "claude-opus-4-7": { contextWindow: 200_000 } })
    expect(completedUsage(mapMessage(result, state, now))?.context).toEqual({ usedTokens: 43_500, maxTokens: 200_000 })
  })

  test("omits the context when the result has no usage for that model", () => {
    const state = newState()
    mapMessage(assistantWithUsage(null, { input_tokens: 1_000, output_tokens: 500 }), state, now)
    const usage = completedUsage(mapMessage(successResult({}), state, now))
    expect(usage).toBeDefined()
    expect(usage?.context).toBeUndefined()
  })
})
