import type { Message, MessagePart } from "./domain.ts"

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface Todo {
  readonly text: string
  readonly status: TodoStatus
}

type ToolPart = Extract<MessagePart, { type: "tool_call" }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asStatus = (value: unknown): TodoStatus => {
  switch (value) {
    case "in_progress":
    case "inProgress":
    case "in-progress":
      return "in_progress"
    case "completed":
    case "complete":
    case "done":
      return "completed"
    case "cancelled":
    case "canceled":
      return "cancelled"
    default:
      return "pending"
  }
}

const readList = (value: unknown, textKey: string): Array<Todo> | null => {
  if (!Array.isArray(value)) return null
  const todos: Array<Todo> = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry[textKey] !== "string") return null
    todos.push({ text: entry[textKey], status: asStatus(entry["status"]) })
  }
  return todos
}

const createdTaskId = (output: unknown): string | null => {
  if (typeof output === "string") return /^Task #(\S+) created/.exec(output)?.[1] ?? null
  if (isRecord(output) && isRecord(output["task"]) && typeof output["task"]["id"] === "string")
    return output["task"]["id"]
  return null
}

export function latestTodos(messages: ReadonlyArray<Message>): ReadonlyArray<Todo> {
  let todos: Array<Todo> = []
  let taskIds: Array<string> = []
  let nextTaskId = 1

  const replaceAll = (next: Array<Todo> | null) => {
    if (next === null) return
    todos = next
    taskIds = next.map(() => "")
    nextTaskId = next.length + 1
  }

  const apply = (part: ToolPart) => {
    if (!isRecord(part.input)) return
    switch (part.name) {
      case "write_todos":
        replaceAll(readList(part.input["todos"], "text"))
        return
      case "TodoWrite":
        replaceAll(readList(part.input["todos"], "content"))
        return
      case "update_plan":
        replaceAll(readList(part.input["plan"], "step"))
        return
      case "TaskCreate": {
        const subject = part.input["subject"]
        if (typeof subject !== "string" || subject === "") return
        const id = createdTaskId(part.output) ?? String(nextTaskId)
        nextTaskId = Math.max(nextTaskId, Number(id) + 1 || nextTaskId + 1)
        taskIds.push(id)
        todos.push({ text: subject, status: "pending" })
        return
      }
      case "TaskUpdate": {
        const taskId = part.input["taskId"]
        if (typeof taskId !== "string") return
        const index = taskIds.indexOf(taskId)
        const current = index === -1 ? undefined : todos[index]
        if (current === undefined) return
        if (part.input["status"] === "deleted") {
          taskIds.splice(index, 1)
          todos.splice(index, 1)
          return
        }
        const subject = part.input["subject"]
        todos[index] = {
          text: typeof subject === "string" && subject !== "" ? subject : current.text,
          status: "status" in part.input ? asStatus(part.input["status"]) : current.status,
        }
        return
      }
      default:
        return
    }
  }

  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type === "tool_call" && part.parentCallId === undefined) apply(part)
    }
  }
  return todos
}
