import { describe, expect, test } from "@effect/vitest"
import type { ThreadItem } from "./protocol.ts"
import { applyChildNotification, applyParentItem, type Subagents } from "./subagents.ts"

const child = "01a12dd6-d3d4-7740-a1cd-738854717f60"
const spawned = {
  type: "subAgentActivity",
  model: "gpt-6-sol",
  id: "call_d58588c685fa4d08844f34780accb852",
  kind: "started",
  agentThreadId: child,
  agentPath: "/root/count_files",
} as const satisfies ThreadItem
const finished = { ...spawned, model: null, id: `subagent-completed-${child}`, kind: "completed" } as const
const command = {
  type: "commandExecution",
  id: "exec-71231033",
  command: "/bin/zsh -lc 'git ls-files | wc -l'",
  cwd: "/repo",
  status: "inProgress",
  aggregatedOutput: null,
  exitCode: null,
  processId: null,
} as const satisfies ThreadItem
const answer = { type: "agentMessage", id: "msg_0f80", text: "218" } as const satisfies ThreadItem
const tokenUsage = {
  total: {
    totalTokens: 43985,
    inputTokens: 43915,
    cachedInputTokens: 34176,
    outputTokens: 70,
    reasoningOutputTokens: 0,
  },
  last: { totalTokens: 22007, inputTokens: 22002, cachedInputTokens: 21760, outputTokens: 5, reasoningOutputTokens: 0 },
}
const toolName = (item: ThreadItem) => (item.type === "commandExecution" ? "Bash" : undefined)
const notify = (subagents: Subagents, method: string, params: unknown) =>
  applyChildNotification(subagents, child, method, { threadId: child, turnId: "t", ...(params as object) }, toolName)

describe("Codex sub-agents", () => {
  test("follows a spawned agent through its own thread's tools, tokens and answer", () => {
    const subagents: Subagents = new Map()

    expect(applyParentItem(subagents, spawned, "2026-10-12T10:00:00.000Z")).toEqual([
      {
        id: child,
        label: "count_files",
        callId: child,
        status: "running",
        summary: null,
        lastTool: null,
        toolUses: 0,
        tokens: 0,
        startedAt: "2026-10-12T10:00:00.000Z",
        endedAt: null,
      },
    ])
    expect(applyParentItem(subagents, spawned, "2026-10-12T10:00:01.000Z")).toEqual([])

    expect(notify(subagents, "item/started", { item: command })).toMatchObject({ lastTool: "Bash", toolUses: 1 })
    expect(notify(subagents, "item/started", { item: answer })).toBeUndefined()
    expect(notify(subagents, "thread/tokenUsage/updated", { tokenUsage })).toMatchObject({ tokens: 43985 })
    expect(notify(subagents, "item/completed", { item: answer })).toMatchObject({ summary: "218" })

    const [done] = applyParentItem(subagents, finished, "2026-10-12T10:00:07.000Z")
    expect(done).toMatchObject({ status: "completed", summary: "218", endedAt: "2026-10-12T10:00:07.000Z" })
    expect(applyParentItem(subagents, finished, "2026-10-12T10:00:08.000Z")).toEqual([])
  })

  test("takes status and message from a collab call's agent states", () => {
    const subagents: Subagents = new Map()
    applyParentItem(subagents, spawned, "2026-10-12T10:00:00.000Z")
    const wait: ThreadItem = {
      type: "collabAgentToolCall",
      id: "call_654a",
      tool: "wait",
      status: "completed",
      senderThreadId: "parent",
      receiverThreadIds: [child],
      prompt: null,
      model: null,
      agentsStates: {
        [child]: { status: "errored", message: "sandbox denied git" },
        unknown: { status: "running", message: null },
      },
    }
    expect(applyParentItem(subagents, wait, "2026-10-12T10:00:05.000Z")).toEqual([
      expect.objectContaining({
        id: child,
        status: "failed",
        summary: "sandbox denied git",
        endedAt: "2026-10-12T10:00:05.000Z",
      }),
    ])
  })

  test("ignores notifications from threads that are not its sub-agents", () => {
    expect(notify(new Map(), "item/started", { item: command })).toBeUndefined()
  })
})
