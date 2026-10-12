import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, test } from "@effect/vitest"
import type { AgentEvent } from "../../../shared/agent.ts"
import { mapMessage, type MapState } from "./mapMessage.ts"

const newState = (): MapState => ({ pendingEdits: new Map(), subagents: new Map() })

const limitResult: SDKResultSuccess = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: "You've hit your limit · resets 3pm (Asia/Tokyo)",
  duration_ms: 0,
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
    iterations: [],
    speed: "standard",
  },
  modelUsage: {},
  permission_denials: [],
  uuid: "8f571b36-b6a9-4e80-a63c-d04254c94f29",
  session_id: "limit-session",
}

describe("mapMessage usage limits", () => {
  test("reports an exhausted account as limited and preserves its explanation", () => {
    expect(mapMessage(limitResult, newState(), "2026-10-12T10:00:00.000Z")).toEqual([
      { type: "turn_limited", message: limitResult.result },
    ])
  })

  test("does not classify unrelated failures or successful prose as account limits", () => {
    const now = "2026-10-12T10:00:00.000Z"
    for (const result of ["Invalid API key", "Server overloaded", "Tool exceeded its output limit"]) {
      expect(mapMessage({ ...limitResult, result }, newState(), now)).toEqual([{ type: "turn_failed", message: result }])
    }
    expect(mapMessage({ ...limitResult, is_error: false }, newState(), now)[0]?.type).toBe("turn_completed")
  })
})

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
