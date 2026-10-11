import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent, TokenUsage } from "../../../shared/agent.ts"

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/**
 * Per-session state the mapper needs across messages: edit tool calls whose result has not arrived
 * yet, so `file_changed` is only emitted once the edit actually succeeded.
 */
export interface MapState {
  readonly pendingEdits: Map<string, string>
}

export const isTerminal = (event: AgentEvent) => event.type === "turn_completed" || event.type === "turn_failed"

export function mapMessage(message: SDKMessage, state: MapState): ReadonlyArray<AgentEvent> {
  switch (message.type) {
    case "system":
      return message.subtype === "init" ? [{ type: "session_bound", providerSessionId: message.session_id }] : []

    case "stream_event": {
      // Subagent output is not streamed into the main transcript; its tool calls still show up below.
      if (message.parent_tool_use_id !== null) return []
      const event = message.event
      if (event.type !== "content_block_delta") return []
      if (event.delta.type === "text_delta" && event.delta.text !== "") {
        return [{ type: "text_delta", text: event.delta.text }]
      }
      if (event.delta.type === "thinking_delta" && event.delta.thinking !== "") {
        return [{ type: "reasoning_delta", text: event.delta.thinking }]
      }
      return []
    }

    case "assistant":
      return message.message.content.flatMap((block): Array<AgentEvent> => {
        if (block.type !== "tool_use") return []
        const input = block.input as Record<string, unknown> | null
        const path = input?.file_path ?? input?.notebook_path
        if (FILE_EDIT_TOOLS.has(block.name) && typeof path === "string") {
          state.pendingEdits.set(block.id, path)
        }
        return [{ type: "tool_call_started", callId: block.id, name: block.name, input: block.input }]
      })

    case "user": {
      if ("isReplay" in message && message.isReplay) return []
      const content = message.message.content
      if (typeof content === "string") return []
      return content.flatMap((block): Array<AgentEvent> => {
        if (block.type !== "tool_result") return []
        const isError = block.is_error ?? false
        const events: Array<AgentEvent> = [
          { type: "tool_call_finished", callId: block.tool_use_id, output: block.content, isError },
        ]
        const path = state.pendingEdits.get(block.tool_use_id)
        state.pendingEdits.delete(block.tool_use_id)
        if (path !== undefined && !isError) events.push({ type: "file_changed", path })
        return events
      })
    }

    case "result":
      return [mapResult(message)]

    default:
      return []
  }
}

function mapResult(result: SDKResultMessage): AgentEvent {
  if (result.subtype !== "success") {
    const reason = result.errors.length > 0 ? result.errors.join("\n") : result.subtype
    return { type: "turn_failed", message: reason }
  }
  // API failures (auth, overload, ...) arrive as a "success" result flagged is_error.
  if (result.is_error) return { type: "turn_failed", message: result.result || "Claude returned an error" }
  return { type: "turn_completed", usage: toUsage(result) }
}

function toUsage(result: SDKResultMessage): TokenUsage {
  const usage = result.usage
  return {
    inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    costUsd: result.total_cost_usd,
  }
}
