import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, test } from "@effect/vitest"
import type { AgentEvent } from "../../../shared/agent.ts"
import { isTerminal, mapMessage, resetTurnLimits, type MapState } from "./mapMessage.ts"
import { orgSpendLimitMessage, usageLimitAssistant, rejectedRateLimit } from "./fixtures/usageLimit.ts"

const newState = (): MapState => ({
  pendingEdits: new Map(),
  subagents: new Map(),
  limitMessage: null,
  limitResetAt: null,
})

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
    fallback_credit: null,
    output_tokens_details: { thinking_tokens: 0 },
  },
  modelUsage: {},
  permission_denials: [],
  uuid: "8f571b36-b6a9-4e80-a63c-d04254c94f29",
  session_id: "limit-session",
}

describe("mapMessage usage limits", () => {
  test("reports an exhausted account as limited and preserves its explanation", () => {
    expect(mapMessage(limitResult, newState(), "2026-10-12T10:00:00.000Z")).toEqual([
      { type: "turn_limited", limit: { kind: "usage", message: limitResult.result, reset: null } },
    ])
  })

  test("does not classify unrelated failures or successful prose as account limits", () => {
    const now = "2026-10-12T10:00:00.000Z"
    for (const result of ["Invalid API key", "Server overloaded", "Tool exceeded its output limit"]) {
      expect(mapMessage({ ...limitResult, result }, newState(), now)).toEqual([
        { type: "turn_failed", message: result },
      ])
    }
    expect(mapMessage({ ...limitResult, is_error: false }, newState(), now)[0]?.type).toBe("turn_completed")
  })

  test("uses a structured rejection for opaque failures and clears it before the next turn", () => {
    const state = newState()
    const now = "2026-10-12T10:00:00.000Z"
    const rejected: SDKMessage = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", overageStatus: "rejected" },
      uuid: limitResult.uuid,
      session_id: limitResult.session_id,
    }
    expect(mapMessage(rejected, state, now)).toEqual([])
    const events = mapMessage({ ...limitResult, result: "Request unavailable" }, state, now)
    expect(events).toEqual([
      { type: "turn_limited", limit: { kind: "usage", message: "Request unavailable", reset: null } },
    ])
    expect(events.every(isTerminal)).toBe(true)
    expect(mapMessage({ ...limitResult, result: "Invalid API key" }, state, now)[0]?.type).toBe("turn_failed")
  })

  test("ignores warnings and subscription limits covered by extra usage", () => {
    const now = "2026-10-12T10:00:00.000Z"
    for (const rate_limit_info of [
      { status: "allowed_warning" },
      { status: "rejected", overageStatus: "allowed" },
      { status: "rejected", isUsingOverage: true },
    ] satisfies Array<Extract<SDKMessage, { type: "rate_limit_event" }>["rate_limit_info"]>) {
      const state = newState()
      mapMessage({ type: "rate_limit_event", rate_limit_info, uuid: limitResult.uuid, session_id: "s" }, state, now)
      expect(mapMessage({ ...limitResult, result: "Invalid API key" }, state, now)[0]?.type).toBe("turn_failed")
    }
  })

  test("a successful turn after a rejection remains successful", () => {
    const state = newState()
    state.limitMessage = "Claude usage limit reached"
    expect(mapMessage({ ...limitResult, is_error: false }, state, "2026-10-12T10:00:00.000Z")[0]?.type).toBe(
      "turn_completed",
    )
    expect(state.limitMessage).toBeNull()
  })

  test("classifies a final HTTP 429 without depending on the message text", () => {
    expect(
      mapMessage({ ...limitResult, api_error_status: 429, result: "Request rejected" }, newState(), "now"),
    ).toEqual([{ type: "turn_limited", limit: { kind: "usage", message: "Request rejected", reset: null } }])
  })

  test("keeps the structured usage reset time for scheduling", () => {
    const state = newState()
    mapMessage(rejectedRateLimit, state, "now")
    mapMessage(usageLimitAssistant, state, "now")
    expect(mapMessage(limitResult, state, "now")).toEqual([
      {
        type: "turn_limited",
        limit: {
          kind: "usage",
          message: limitResult.result,
          reset: { at: "2026-10-12T06:00:00.000Z", autoResume: false },
        },
      },
    ])
  })

  test("the recorded org spend error ignores the unrelated session reset", () => {
    const state = newState()
    mapMessage(rejectedRateLimit, state, "now")
    const assistant: SDKMessage = {
      ...usageLimitAssistant,
      message: {
        ...usageLimitAssistant.message,
        content: [{ type: "text", text: orgSpendLimitMessage, citations: [] }],
      },
    }
    expect(mapMessage(assistant, state, "now")).toEqual([])
    expect(mapMessage({ ...limitResult, result: orgSpendLimitMessage }, state, "now")).toEqual([
      { type: "turn_limited", limit: { kind: "org_spend", message: orgSpendLimitMessage } },
    ])
    expect(
      mapMessage({ ...limitResult, result: `Error: ${orgSpendLimitMessage}` }, newState(), "now")[0],
    ).toMatchObject({
      type: "turn_limited",
      limit: { kind: "org_spend" },
    })
  })

  test("a subagent rate error does not mark an unrelated parent failure as limited", () => {
    const state = newState()
    mapMessage({ ...usageLimitAssistant, parent_tool_use_id: "subagent-tool" }, state, "now")
    expect(mapMessage({ ...limitResult, result: "Invalid API key" }, state, "now")[0]?.type).toBe("turn_failed")
  })

  test("discarding an aborted result clears its rejection before the next response", () => {
    const state = newState()
    mapMessage(rejectedRateLimit, state, "now")
    mapMessage(usageLimitAssistant, state, "now")
    resetTurnLimits(state)
    expect(mapMessage({ ...limitResult, result: "Invalid API key" }, state, "now")).toEqual([
      { type: "turn_failed", message: "Invalid API key" },
    ])
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
