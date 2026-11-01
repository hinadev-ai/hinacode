import { describe, expect, it } from "vitest"
import type { Message, MessagePart } from "./domain.ts"
import { latestTodos } from "./todos.ts"

const tool = (name: string, input: unknown, output?: unknown, parentCallId?: string): MessagePart => ({
  type: "tool_call",
  callId: `${name}-${Math.random()}`,
  name,
  input,
  ...(output === undefined ? {} : { output }),
  status: "done",
  ...(parentCallId === undefined ? {} : { parentCallId }),
})

const message = (...parts: Array<MessagePart>): Message => ({
  id: `m-${Math.random()}`,
  threadId: "t1",
  role: "assistant",
  parts,
  createdAt: "2026-10-13T00:00:00.000Z",
  completedAt: null,
  usage: null,
  forkPoint: null,
})

describe("latestTodos", () => {
  it("reads a Muse write_todos call, whose result is only an acknowledgement", () => {
    const messages = [
      message(
        tool(
          "write_todos",
          {
            todos: [
              { text: "Reproduce skills failure in isolated app (commands.list over CDP)", status: "in_progress" },
              { text: "Fix skills root cause + surface load errors in composer", status: "pending" },
              { text: "Fix model picker: open above composer, show all models", status: "pending" },
            ],
          },
          '{"ok":true,"revision":1,"items":3}',
        ),
      ),
    ]
    expect(latestTodos(messages)).toEqual([
      { text: "Reproduce skills failure in isolated app (commands.list over CDP)", status: "in_progress" },
      { text: "Fix skills root cause + surface load errors in composer", status: "pending" },
      { text: "Fix model picker: open above composer, show all models", status: "pending" },
    ])
  })

  it("keeps only the newest replace-all list", () => {
    const messages = [
      message(tool("write_todos", { todos: [{ text: "old", status: "pending" }] })),
      message(tool("Bash", { command: "ls" })),
      message(
        tool("write_todos", {
          todos: [
            { text: "old", status: "completed" },
            { text: "new", status: "cancelled" },
          ],
        }),
      ),
    ]
    expect(latestTodos(messages)).toEqual([
      { text: "old", status: "completed" },
      { text: "new", status: "cancelled" },
    ])
  })

  it("reads a legacy Claude TodoWrite call", () => {
    const messages = [
      message(
        tool("TodoWrite", {
          todos: [
            { content: "Read the code", activeForm: "Reading the code", status: "completed" },
            { content: "Write the fix", activeForm: "Writing the fix", status: "in_progress" },
          ],
        }),
      ),
    ]
    expect(latestTodos(messages)).toEqual([
      { text: "Read the code", status: "completed" },
      { text: "Write the fix", status: "in_progress" },
    ])
  })

  it("folds Claude TaskCreate and TaskUpdate calls by task id", () => {
    const messages = [
      message(
        tool(
          "TaskCreate",
          { subject: "Read README.md", description: "Read README.md", activeForm: "Reading README.md" },
          "Task #1 created successfully: Read README.md",
        ),
        tool(
          "TaskCreate",
          { subject: "Read math.js", description: "Read math.js", activeForm: "Reading math.js" },
          "Task #2 created successfully: Read math.js",
        ),
        tool("TaskUpdate", { taskId: "1", status: "in_progress" }, "Updated task #1 status"),
      ),
      message(tool("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status")),
    ]
    expect(latestTodos(messages)).toEqual([
      { text: "Read README.md", status: "completed" },
      { text: "Read math.js", status: "pending" },
    ])
  })

  it("drops a task the agent deleted", () => {
    const messages = [
      message(
        tool("TaskCreate", { subject: "Keep" }, "Task #1 created successfully: Keep"),
        tool("TaskCreate", { subject: "Drop" }, "Task #2 created successfully: Drop"),
        tool("TaskUpdate", { taskId: "2", status: "deleted" }),
      ),
    ]
    expect(latestTodos(messages)).toEqual([{ text: "Keep", status: "pending" }])
  })

  it("reads a Codex update_plan call", () => {
    const messages = [
      message(
        tool("update_plan", {
          explanation: "Two steps left",
          plan: [
            { step: "Verify each PR independently", status: "completed" },
            { step: "Merge only the contiguous run", status: "inProgress" },
            { step: "Report back", status: "pending" },
          ],
        }),
      ),
    ]
    expect(latestTodos(messages)).toEqual([
      { text: "Verify each PR independently", status: "completed" },
      { text: "Merge only the contiguous run", status: "in_progress" },
      { text: "Report back", status: "pending" },
    ])
  })

  it("ignores a sub-agent's own list", () => {
    const messages = [
      message(
        tool("write_todos", { todos: [{ text: "main", status: "in_progress" }] }),
        tool("write_todos", { todos: [{ text: "child", status: "pending" }] }, undefined, "call-parent"),
      ),
    ]
    expect(latestTodos(messages)).toEqual([{ text: "main", status: "in_progress" }])
  })

  it("returns nothing for malformed calls instead of throwing", () => {
    const messages = [
      message(
        tool("write_todos", { todos: "nope" }),
        tool("TodoWrite", null),
        tool("TaskCreate", { subject: 42 }),
        tool("update_plan", { plan: [{ status: "pending" }] }),
      ),
    ]
    expect(latestTodos(messages)).toEqual([])
    expect(latestTodos([])).toEqual([])
  })
})
