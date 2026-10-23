import { describe, expect, test } from "@effect/vitest"
import { backgroundTasksAfter, isBackgrounded } from "./backgroundTasks.ts"
import type { ToolCall } from "./protocol.ts"

const NOW = "2026-10-23T12:00:00.000Z"
const LATER = "2026-10-23T12:05:00.000Z"

const shell = (fields: Partial<ToolCall>): ToolCall => ({
  itemId: "call-1",
  kind: "toolCall",
  status: "inProgress",
  tool: "bash",
  args: JSON.stringify({ command: "pnpm dev", description: "Start the dev server" }),
  ...fields,
})

const yielded = shell({ backgroundStatus: { state: "backgrounded" } })

describe("isBackgrounded", () => {
  test("knows a call Muse backgrounded past its yield time and one sent there by task/background", () => {
    expect(isBackgrounded(yielded)).toBe(true)
    expect(isBackgrounded(shell({ background: true }))).toBe(true)
  })

  test("leaves a foreground call and a finished one out", () => {
    expect(isBackgrounded(shell({}))).toBe(false)
    expect(isBackgrounded(shell({ background: true, status: "completed" }))).toBe(false)
  })
})

describe("backgroundTasksAfter", () => {
  test("adds a shell that went to the background, labelled with its description", () => {
    expect(backgroundTasksAfter([], yielded, NOW)).toStrictEqual([
      { id: "call-1", kind: "shell", label: "Start the dev server", startedAt: NOW },
    ])
  })

  test("labels a call without a description by its command, then by its tool", () => {
    const [byCommand] = backgroundTasksAfter([], { ...yielded, args: '{"command":"sleep 30"}' }, NOW)
    expect(byCommand).toMatchObject({ kind: "shell", label: "sleep 30" })
    const [byTool] = backgroundTasksAfter([], { ...yielded, tool: "monitor", args: "{}" }, NOW)
    expect(byTool).toMatchObject({ kind: "other", label: "monitor" })
  })

  test("returns the same set while nothing changes", () => {
    const tasks = backgroundTasksAfter([], yielded, NOW)
    expect(backgroundTasksAfter(tasks, yielded, LATER)).toBe(tasks)
    expect(backgroundTasksAfter(tasks, shell({}), LATER)).toBe(tasks)
    const none: ReadonlyArray<never> = []
    expect(backgroundTasksAfter(none, shell({}), NOW)).toBe(none)
    expect(backgroundTasksAfter(none, shell({ status: "completed" }), NOW)).toBe(none)
  })

  test("drops a task once its call ends, however it ends", () => {
    const tasks = backgroundTasksAfter([], yielded, NOW)
    expect(backgroundTasksAfter(tasks, shell({ status: "completed" }), LATER)).toStrictEqual([])
    expect(backgroundTasksAfter(tasks, shell({ status: "cancelled", background: true }), LATER)).toStrictEqual([])
  })
})
