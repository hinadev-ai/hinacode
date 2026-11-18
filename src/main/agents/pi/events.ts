import { isAbsolute, resolve } from "node:path"
import { Option, Predicate, Schema } from "effect"
import type { AgentEvent, TokenUsage } from "../../../shared/agent.ts"
import { interruptedTurn } from "../provider.ts"
import { AssistantMessage, PiEvent } from "./protocol.ts"

export const PI_LOGIN_COMMAND = "pi auth login"

const decodeEvent = Schema.decodeUnknownOption(PiEvent)
const decodeAssistant = Schema.decodeUnknownOption(AssistantMessage)

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ImageBlock = Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String })
const decodeText = Schema.decodeUnknownOption(TextBlock)
const decodeImage = Schema.decodeUnknownOption(ImageBlock)

const toolNames: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
}

const fileTools = new Set(["read", "edit", "write"])

export const displayName = (toolName: string) => toolNames[toolName] ?? toolName

export interface PiToolCall {
  readonly name: string
  readonly args: Record<string, unknown>
}

const record = (value: unknown): Record<string, unknown> => (Predicate.isObject(value) ? { ...value } : {})

export const stringArg = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

const absolute = (cwd: string, path: string) => (isAbsolute(path) ? path : resolve(cwd, path))

export const toolPath = (call: PiToolCall, cwd: string) => {
  const path = stringArg(call.args, "path")
  return path === undefined ? undefined : absolute(cwd, path)
}

export const toolInput = (call: PiToolCall, cwd: string): Record<string, unknown> => {
  const path = toolPath(call, cwd)
  return fileTools.has(call.name) && path !== undefined ? { ...call.args, file_path: path } : call.args
}

const toolOutput = (content: ReadonlyArray<unknown>): unknown => {
  const texts = content.flatMap((block) => Option.toArray(decodeText(block)).map((text) => text.text))
  const images = content.flatMap((block) => Option.toArray(decodeImage(block)))
  if (images.length > 0) return [...texts.map((text) => ({ type: "text", text })), ...images]
  return texts.join("\n")
}

const patchOf = (details: unknown) => stringArg(record(details), "patch")

const authProblem = /oauth|api key|unauthori[sz]ed|authenticat|credential|invalid_grant|\b401\b/i

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? ""

export interface EventMapper {
  readonly apply: (event: unknown) => ReadonlyArray<AgentEvent>
  readonly tool: (toolCallId: string) => PiToolCall | undefined
  readonly closeOpenTools: (output: string) => ReadonlyArray<AgentEvent>
  readonly settle: (aborted: boolean, contextWindow: number | null) => ReadonlyArray<AgentEvent>
}

export const makeEventMapper = (cwd: string): EventMapper => {
  const calls = new Map<string, PiToolCall>()
  const open = new Set<string>()
  const totals = { input: 0, output: 0, cost: 0 }
  let last: typeof AssistantMessage.Type | undefined

  const remember = (id: string, name: string, args: unknown) => {
    const call = { name, args: record(args) }
    calls.set(id, call)
    return call
  }

  const assistantEnded = (message: unknown) => {
    const assistant = decodeAssistant(message)
    if (Option.isNone(assistant)) return
    last = assistant.value
    const { usage } = assistant.value
    if (usage === undefined) return
    totals.input += usage.input + usage.cacheRead + usage.cacheWrite
    totals.output += usage.output
    totals.cost += usage.cost?.total ?? 0
  }

  const apply = (raw: unknown): ReadonlyArray<AgentEvent> => {
    const decoded = decodeEvent(raw)
    if (Option.isNone(decoded)) return []
    const event = decoded.value
    switch (event.type) {
      case "message_update": {
        const { type, delta, toolCall } = event.assistantMessageEvent
        if (type === "toolcall_end" && toolCall !== undefined) remember(toolCall.id, toolCall.name, toolCall.arguments)
        if (delta === undefined || delta === "") return []
        if (type === "text_delta") return [{ type: "text_delta", text: delta }]
        if (type === "thinking_delta") return [{ type: "reasoning_delta", text: delta }]
        return []
      }
      case "message_end":
        assistantEnded(event.message)
        return []
      case "tool_execution_start": {
        if (open.has(event.toolCallId)) return []
        const call = remember(event.toolCallId, event.toolName, event.args ?? calls.get(event.toolCallId)?.args)
        open.add(event.toolCallId)
        return [
          {
            type: "tool_call_started",
            callId: event.toolCallId,
            name: displayName(call.name),
            input: toolInput(call, cwd),
          },
        ]
      }
      case "tool_execution_end": {
        if (!open.delete(event.toolCallId)) return []
        const isError = event.isError === true
        const events: Array<AgentEvent> = [
          {
            type: "tool_call_finished",
            callId: event.toolCallId,
            output: toolOutput(event.result?.content ?? []),
            isError,
          },
        ]
        const call = calls.get(event.toolCallId)
        const path = call === undefined ? undefined : toolPath(call, cwd)
        if (!isError && path !== undefined && (event.toolName === "edit" || event.toolName === "write")) {
          const diff = patchOf(event.result?.details)
          events.push({ type: "file_changed", path, ...(diff !== undefined && { diff }) })
        }
        return events
      }
      case "compaction_start":
        return [{ type: "compaction_updated", compaction: { status: "running" } }]
      case "compaction_end": {
        const { result } = event
        if (result == null) {
          return [{ type: "compaction_updated", compaction: { status: "failed", message: event.errorMessage ?? null } }]
        }
        return [
          {
            type: "compaction_updated",
            compaction: {
              status: "done",
              trigger: event.reason === "manual" ? "manual" : "auto",
              preTokens: result.tokensBefore ?? null,
              postTokens: result.estimatedTokensAfter ?? null,
            },
          },
        ]
      }
      case "agent_settled":
        return []
    }
  }

  const closeOpenTools = (output: string) => {
    const closed = [...open].map((callId): AgentEvent => ({
      type: "tool_call_finished",
      callId,
      output,
      isError: true,
    }))
    open.clear()
    return closed
  }

  const usage = (contextWindow: number | null): TokenUsage => {
    const used = last?.usage
    return {
      inputTokens: totals.input,
      outputTokens: totals.output,
      ...(totals.cost > 0 && { costUsd: totals.cost }),
      ...(used !== undefined &&
        contextWindow !== null &&
        contextWindow > 0 && {
          context: {
            usedTokens: used.input + used.cacheRead + used.cacheWrite + used.output,
            maxTokens: contextWindow,
          },
        }),
    }
  }

  const settle = (aborted: boolean, contextWindow: number | null): ReadonlyArray<AgentEvent> => {
    if (aborted) return [...closeOpenTools("Interrupted"), interruptedTurn]
    const closed = closeOpenTools("Turn ended")
    if (last?.stopReason === "error") {
      const message = firstLine(last.errorMessage ?? "") || "pi stopped with an error"
      const signedOut = authProblem.test(message)
      return [
        ...closed,
        { type: "turn_failed", message, ...(signedOut && { signedOut, loginCommand: PI_LOGIN_COMMAND }) },
      ]
    }
    return [...closed, { type: "turn_completed", usage: usage(contextWindow) }]
  }

  return { apply, tool: (id) => calls.get(id), closeOpenTools, settle }
}
