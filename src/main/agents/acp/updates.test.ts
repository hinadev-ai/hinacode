import { describe, expect, test } from "@effect/vitest"
import { makeUpdateMapper } from "./updates.ts"

const FILE = "/repo/hello.txt"

const plan = (status: string) => ({
  sessionUpdate: "plan",
  entries: [
    { content: "Write tests", priority: "high", status: "completed" },
    { content: "Fix bug", priority: "medium", status },
  ],
})

describe("makeUpdateMapper", () => {
  test("streams message and thought chunks as deltas", () => {
    const mapper = makeUpdateMapper("turn")
    expect([
      ...mapper.apply({
        sessionUpdate: "agent_thought_chunk",
        messageId: "m1",
        content: { type: "text", text: "Hmm" },
      }),
      ...mapper.apply({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Hi" } }),
      ...mapper.apply({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "", mimeType: "x" } }),
    ]).toStrictEqual([
      { type: "reasoning_delta", text: "Hmm" },
      { type: "text_delta", text: "Hi" },
    ])
  })

  test("holds a pending opencode write until its input arrives, then finishes it with the file change", () => {
    const mapper = makeUpdateMapper("turn")
    const id = { sessionUpdate: "tool_call_update", toolCallId: "call_1" }
    expect(
      mapper.apply({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "write",
        kind: "edit",
        status: "pending",
        locations: [],
        rawInput: {},
      }),
    ).toStrictEqual([])
    expect(
      mapper.apply({
        ...id,
        status: "in_progress",
        kind: "edit",
        title: "write",
        locations: [{ path: FILE }],
        rawInput: { filePath: FILE, content: "hi" },
      }),
    ).toStrictEqual([
      {
        type: "tool_call_started",
        callId: "call_1",
        name: "Edit",
        input: { filePath: FILE, content: "hi", file_path: FILE },
      },
    ])
    expect(mapper.apply({ ...id, status: "in_progress", rawInput: { filePath: FILE, content: "hi" } })).toStrictEqual(
      [],
    )
    expect(
      mapper.apply({
        ...id,
        status: "completed",
        title: "hello.txt",
        content: [{ type: "content", content: { type: "text", text: "Wrote file successfully." } }],
        rawOutput: { output: "", metadata: {} },
      }),
    ).toStrictEqual([
      { type: "tool_call_finished", callId: "call_1", output: "Wrote file successfully.", isError: false },
      { type: "file_changed", path: FILE },
    ])
    expect(mapper.apply({ ...id, status: "completed" })).toStrictEqual([])
    expect(mapper.closeOpenTools("Interrupted")).toStrictEqual([])
  })

  test("names a shell call Bash with its command once opencode sends it", () => {
    const mapper = makeUpdateMapper("turn")
    const id = { toolCallId: "call_2" }
    expect(
      mapper.apply({
        sessionUpdate: "tool_call",
        ...id,
        title: "bash",
        kind: "execute",
        status: "pending",
        rawInput: { cwd: "/repo" },
      }),
    ).toStrictEqual([])
    expect(
      mapper.apply({
        sessionUpdate: "tool_call_update",
        ...id,
        status: "in_progress",
        rawInput: { command: "ls", cwd: "/repo" },
      }),
    ).toStrictEqual([
      { type: "tool_call_started", callId: "call_2", name: "Bash", input: { command: "ls", cwd: "/repo" } },
    ])
    expect(
      mapper.apply({
        sessionUpdate: "tool_call_update",
        ...id,
        status: "failed",
        rawOutput: { output: "ls: cannot access", metadata: { exit: 2 } },
      }),
    ).toStrictEqual([{ type: "tool_call_finished", callId: "call_2", output: "ls: cannot access", isError: true }])
  })

  test("reports the path of every diff block, and starts a call that completes at once", () => {
    const mapper = makeUpdateMapper("turn")
    expect(
      mapper.apply({
        sessionUpdate: "tool_call",
        toolCallId: "call_3",
        title: "Apply patch",
        kind: "other",
        status: "completed",
        content: [
          { type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" },
          { type: "diff", path: "/repo/b.ts", oldText: null, newText: "c" },
          { type: "terminal", terminalId: "t1" },
        ],
        rawInput: { patch: "..." },
        rawOutput: { output: "Done" },
      }),
    ).toStrictEqual([
      { type: "tool_call_started", callId: "call_3", name: "Apply patch", input: { patch: "..." } },
      { type: "tool_call_finished", callId: "call_3", output: "Done", isError: false },
      { type: "file_changed", path: "/repo/a.ts" },
      { type: "file_changed", path: "/repo/b.ts" },
    ])
  })

  test("closes started calls once, and skips calls that never started", () => {
    const mapper = makeUpdateMapper("turn")
    mapper.apply({ sessionUpdate: "tool_call", toolCallId: "open", kind: "read", status: "in_progress", title: "read" })
    mapper.apply({ sessionUpdate: "tool_call", toolCallId: "waiting", kind: "read", status: "pending", title: "read" })
    expect(mapper.closeOpenTools("Interrupted")).toStrictEqual([
      { type: "tool_call_finished", callId: "open", output: "Interrupted", isError: true },
    ])
    expect(mapper.closeOpenTools("Interrupted")).toStrictEqual([])
    expect(mapper.apply({ sessionUpdate: "tool_call_update", toolCallId: "open", status: "completed" })).toStrictEqual(
      [],
    )
  })

  test("turns each plan into an update_plan call the todo list reads", () => {
    const mapper = makeUpdateMapper("turn")
    expect([...mapper.apply(plan("in_progress")), ...mapper.apply(plan("pending"))]).toStrictEqual([
      {
        type: "tool_call_started",
        callId: "turn-plan-1",
        name: "update_plan",
        input: {
          plan: [
            { step: "Write tests", status: "completed" },
            { step: "Fix bug", status: "in_progress" },
          ],
        },
      },
      { type: "tool_call_finished", callId: "turn-plan-1", output: "Plan updated", isError: false },
      {
        type: "tool_call_started",
        callId: "turn-plan-2",
        name: "update_plan",
        input: {
          plan: [
            { step: "Write tests", status: "completed" },
            { step: "Fix bug", status: "pending" },
          ],
        },
      },
      { type: "tool_call_finished", callId: "turn-plan-2", output: "Plan updated", isError: false },
    ])
  })

  test("remembers the context window from usage updates", () => {
    const mapper = makeUpdateMapper("turn")
    expect(mapper.context()).toBeUndefined()
    expect(
      mapper.apply({ sessionUpdate: "usage_update", used: 20347, size: 200000, cost: { amount: 0, currency: "USD" } }),
    ).toStrictEqual([])
    expect(mapper.context()).toStrictEqual({ usedTokens: 20347, maxTokens: 200000 })
  })

  test("ignores updates it does not map", () => {
    const mapper = makeUpdateMapper("turn")
    expect([
      ...mapper.apply({ sessionUpdate: "available_commands_update", availableCommands: [] }),
      ...mapper.apply({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
      ...mapper.apply({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } }),
      ...mapper.apply("garbage"),
    ]).toStrictEqual([])
  })
})
