import { Option, Predicate, Schema } from "effect"
import type { AgentEvent, ContextWindow } from "../../../shared/agent.ts"
import { ToolCallFields } from "./protocol.ts"

const TextChunk = Schema.Struct({
  sessionUpdate: Schema.Literals(["agent_message_chunk", "agent_thought_chunk"]),
  content: Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
})

const ToolCallUpdate = Schema.Struct({
  sessionUpdate: Schema.Literals(["tool_call", "tool_call_update"]),
  ...ToolCallFields.fields,
})

const PlanUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("plan"),
  entries: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })),
})

const UsageUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("usage_update"),
  used: Schema.Number,
  size: Schema.Number,
})

const SessionUpdate = Schema.Union([TextChunk, ToolCallUpdate, PlanUpdate, UsageUpdate])
const decodeUpdate = Schema.decodeUnknownOption(SessionUpdate)

const TextContent = Schema.Struct({
  type: Schema.Literal("content"),
  content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
})
const DiffContent = Schema.Struct({ type: Schema.Literal("diff"), path: Schema.String })
const decodeTextContent = Schema.decodeUnknownOption(TextContent)
const decodeDiffContent = Schema.decodeUnknownOption(DiffContent)

export interface ToolState {
  readonly id: string
  kind: string | null
  title: string
  status: string
  locations: ReadonlyArray<string>
  content: ReadonlyArray<unknown>
  rawInput: unknown
  rawOutput: unknown
  started: boolean
}

const record = (value: unknown): Record<string, unknown> => (Predicate.isObject(value) ? { ...value } : {})

const stringField = (value: unknown, key: string): string | undefined => {
  const field = record(value)[key]
  return typeof field === "string" && field !== "" ? field : undefined
}

export const toolPath = (tool: ToolState): string | undefined =>
  tool.locations[0] ?? stringField(tool.rawInput, "filePath") ?? stringField(tool.rawInput, "path")

export const toolCommand = (tool: ToolState): string =>
  stringField(tool.rawInput, "command") ?? (tool.title === "" ? "command" : tool.title)

const toolNames: Record<string, string> = {
  execute: "Bash",
  edit: "Edit",
  read: "Read",
  search: "Grep",
  fetch: "WebFetch",
}

export const toolName = (tool: ToolState) =>
  toolNames[tool.kind ?? ""] ?? (tool.title === "" ? (tool.kind ?? "tool") : tool.title)

export const toolInput = (tool: ToolState): unknown => {
  const input = record(tool.rawInput)
  const path = toolPath(tool)
  switch (tool.kind) {
    case "execute":
      return { ...input, command: toolCommand(tool) }
    case "edit":
    case "read":
      return path === undefined ? input : { ...input, file_path: path }
    case "search":
      return { ...input, pattern: stringField(input, "pattern") ?? tool.title }
    case "fetch":
      return { ...input, url: stringField(input, "url") ?? tool.title }
    default:
      return Predicate.isObject(tool.rawInput) ? tool.rawInput : (tool.rawInput ?? {})
  }
}

const toolOutput = (tool: ToolState): unknown => {
  const texts = tool.content.flatMap((block) =>
    Option.match(decodeTextContent(block), { onNone: () => [], onSome: ({ content }) => [content.text] }),
  )
  if (texts.length > 0) return texts.join("\n")
  return stringField(tool.rawOutput, "output") ?? tool.rawOutput ?? ""
}

const fileChanges = (tool: ToolState): ReadonlyArray<string> => {
  const diffs = tool.content.flatMap((block) =>
    Option.match(decodeDiffContent(block), { onNone: () => [], onSome: ({ path }) => [path] }),
  )
  if (diffs.length > 0) return [...new Set(diffs)]
  if (tool.kind !== "edit" && tool.kind !== "delete" && tool.kind !== "move") return []
  const path = toolPath(tool)
  return path === undefined ? [] : [path]
}

const isFinished = (status: string) => status === "completed" || status === "failed"

export interface UpdateMapper {
  readonly apply: (update: unknown) => ReadonlyArray<AgentEvent>
  readonly tool: (toolCallId: string) => ToolState | undefined
  readonly closeOpenTools: (output: string) => ReadonlyArray<AgentEvent>
  readonly context: () => ContextWindow | undefined
}

export const makeUpdateMapper = (planIdPrefix: string): UpdateMapper => {
  const tools = new Map<string, ToolState>()
  let context: ContextWindow | undefined
  let planRevision = 0

  const applyTool = (fields: typeof ToolCallUpdate.Type): ReadonlyArray<AgentEvent> => {
    const tool: ToolState = tools.get(fields.toolCallId) ?? {
      id: fields.toolCallId,
      kind: null,
      title: "",
      status: "pending",
      locations: [],
      content: [],
      rawInput: undefined,
      rawOutput: undefined,
      started: false,
    }
    tools.set(tool.id, tool)
    if (isFinished(tool.status)) return []
    if (fields.kind != null) tool.kind = fields.kind
    if (fields.title != null) tool.title = fields.title
    if (fields.status != null) tool.status = fields.status
    if (fields.locations != null && fields.locations.length > 0) tool.locations = fields.locations.map((l) => l.path)
    if (fields.content != null) tool.content = fields.content
    if (fields.rawInput !== undefined && Object.keys(record(fields.rawInput)).length > 0)
      tool.rawInput = fields.rawInput
    if (fields.rawOutput !== undefined) tool.rawOutput = fields.rawOutput

    const events: Array<AgentEvent> = []
    if (!tool.started && tool.status !== "pending") {
      tool.started = true
      events.push({ type: "tool_call_started", callId: tool.id, name: toolName(tool), input: toolInput(tool) })
    }
    if (tool.started && isFinished(tool.status)) {
      const isError = tool.status === "failed"
      events.push({ type: "tool_call_finished", callId: tool.id, output: toolOutput(tool), isError })
      if (!isError) for (const path of fileChanges(tool)) events.push({ type: "file_changed", path })
    }
    return events
  }

  const apply = (raw: unknown): ReadonlyArray<AgentEvent> => {
    const decoded = decodeUpdate(raw)
    if (Option.isNone(decoded)) return []
    const update = decoded.value
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const { text } = update.content
        if (update.content.type !== "text" || text === undefined || text === "") return []
        return [{ type: update.sessionUpdate === "agent_message_chunk" ? "text_delta" : "reasoning_delta", text }]
      }
      case "tool_call":
      case "tool_call_update":
        return applyTool(update)
      case "plan": {
        const callId = `${planIdPrefix}-plan-${++planRevision}`
        const plan = update.entries.map((entry) => ({ step: entry.content, status: entry.status }))
        return [
          { type: "tool_call_started", callId, name: "update_plan", input: { plan } },
          { type: "tool_call_finished", callId, output: "Plan updated", isError: false },
        ]
      }
      case "usage_update":
        context = { usedTokens: update.used, maxTokens: update.size }
        return []
    }
  }

  const closeOpenTools = (output: string) =>
    [...tools.values()].flatMap((tool): ReadonlyArray<AgentEvent> => {
      if (!tool.started || isFinished(tool.status)) return []
      tool.status = "failed"
      return [{ type: "tool_call_finished", callId: tool.id, output, isError: true }]
    })

  return { apply, tool: (id) => tools.get(id), closeOpenTools, context: () => context }
}
