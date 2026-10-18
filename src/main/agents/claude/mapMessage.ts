import type {
  SDKMessage,
  SDKResultMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent, Subagent, TokenUsage } from "../../../shared/agent.ts"

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/**
 * Per-session state the mapper needs across messages: edit tool calls whose result has not arrived
 * yet, so `file_changed` is only emitted once the edit actually succeeded, and the sub-agents seen
 * so far, since task progress messages only carry what changed.
 */
export interface MapState {
  readonly pendingEdits: Map<string, string>
  readonly subagents: Map<string, Subagent>
  lastRequest: { readonly model: string; readonly usedTokens: number } | null
  limitMessage: string | null
  limitResetAt: string | null
}

export const isTerminal = (event: AgentEvent) =>
  event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_limited"

export function resetTurnLimits(state: MapState): void {
  state.limitMessage = null
  state.limitResetAt = null
}

export function mapMessage(message: SDKMessage, state: MapState, now: string): ReadonlyArray<AgentEvent> {
  switch (message.type) {
    case "system":
      switch (message.subtype) {
        case "init":
          return [{ type: "session_bound", providerSessionId: message.session_id }]
        case "task_started":
          return subagentStarted(message, state, now)
        case "task_progress":
          return subagentProgress(message, state)
        case "task_notification":
          return subagentEnded(message, state, now)
        default:
          return []
      }

    case "stream_event": {
      // Subagent text is not streamed into the transcript; only its tool calls are, tagged with parentCallId.
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

    case "rate_limit_event": {
      const info = message.rate_limit_info
      if (
        info.status === "rejected" &&
        info.overageStatus !== "allowed" &&
        info.overageStatus !== "allowed_warning" &&
        !info.isUsingOverage &&
        !info.overageInUse
      ) {
        state.limitMessage = "Claude usage limit reached"
        const resetMs = (info.resetsAt ?? Number.NaN) * 1000
        state.limitResetAt =
          Number.isFinite(resetMs) && Math.abs(resetMs) <= 8.64e15 ? new Date(resetMs).toISOString() : null
      }
      return []
    }

    case "assistant":
      if (message.parent_tool_use_id === null) {
        const usage = message.message.usage
        state.lastRequest = {
          model: message.message.model,
          usedTokens:
            usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            usage.output_tokens,
        }
      }
      if (message.parent_tool_use_id === null && message.error === "rate_limit") {
        state.limitMessage =
          message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ||
          "Claude usage limit reached"
      }
      const parentCallId = message.parent_tool_use_id
      return message.message.content.flatMap((block): Array<AgentEvent> => {
        if (block.type !== "tool_use") return []
        const input = block.input as Record<string, unknown> | null
        const path = input?.file_path ?? input?.notebook_path
        if (FILE_EDIT_TOOLS.has(block.name) && typeof path === "string") {
          state.pendingEdits.set(block.id, path)
        }
        return [
          {
            type: "tool_call_started",
            callId: block.id,
            name: block.name,
            input: block.input,
            ...(parentCallId !== null && { parentCallId }),
          },
        ]
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

    case "result": {
      const limitMessage = state.limitMessage
      const resetAt = state.limitResetAt
      resetTurnLimits(state)
      return [mapResult(message, limitMessage, resetAt, state)]
    }

    default:
      return []
  }
}

/** Only spawned agents count; background shells, monitors and housekeeping tasks are not sub-agents. */
const isSubagent = (message: SDKTaskStartedMessage) =>
  message.task_type === "local_agent" && message.ambient !== true && message.skip_transcript !== true

function subagentStarted(message: SDKTaskStartedMessage, state: MapState, now: string): Array<AgentEvent> {
  if (!isSubagent(message)) return []
  return updateSubagent(state, {
    id: message.task_id,
    label: message.description,
    callId: message.tool_use_id ?? null,
    status: "running",
    summary: null,
    lastTool: null,
    toolUses: 0,
    tokens: 0,
    startedAt: now,
    endedAt: null,
  })
}

function subagentProgress(message: SDKTaskProgressMessage, state: MapState): Array<AgentEvent> {
  const current = state.subagents.get(message.task_id)
  if (current === undefined) return []
  // Without agentProgressSummaries' `summary`, the CLI still rewrites `description` into what the agent is doing now.
  const activity = message.description !== current.label ? message.description : null
  return updateSubagent(state, {
    ...current,
    summary: message.summary ?? activity ?? current.summary,
    lastTool: message.last_tool_name ?? current.lastTool,
    toolUses: message.usage.tool_uses,
    tokens: message.usage.total_tokens,
  })
}

function subagentEnded(message: SDKTaskNotificationMessage, state: MapState, now: string): Array<AgentEvent> {
  const current = state.subagents.get(message.task_id)
  if (current === undefined) return []
  return updateSubagent(state, {
    ...current,
    status: message.status,
    // A stopped task reports its own description as the summary, which says nothing new.
    summary: message.summary === "" || message.summary === current.label ? current.summary : message.summary,
    toolUses: message.usage?.tool_uses ?? current.toolUses,
    tokens: message.usage?.total_tokens ?? current.tokens,
    endedAt: now,
  })
}

function updateSubagent(state: MapState, subagent: Subagent): Array<AgentEvent> {
  state.subagents.set(subagent.id, subagent)
  return [{ type: "subagent_updated", subagent }]
}

const limitErrorText =
  /^(?:error:\s*)?(?:you['’]ve hit your (?:(?:usage )?limit|org['’]s monthly spend limit)|usage limit reached|(?:claude(?: api)? )?rate limit reached|api error:\s*429\b)/i
const orgSpendLimitText = /^(?:error:\s*)?you['’]ve hit your org['’]s monthly spend limit/i

function mapResult(
  result: SDKResultMessage,
  limitMessage: string | null,
  resetAt: string | null,
  state: MapState,
): AgentEvent {
  if (result.subtype !== "success" || result.is_error) {
    const reason = result.subtype === "success" ? result.result : result.errors.join("\n")
    const limited =
      limitMessage !== null ||
      ("api_error_status" in result && result.api_error_status === 429) ||
      limitErrorText.test(reason)
    const message =
      limitMessage && limitMessage !== "Claude usage limit reached"
        ? limitMessage
        : reason || limitMessage || (result.subtype === "success" ? "Claude returned an error" : result.subtype)
    if (limited) {
      return {
        type: "turn_limited",
        limit:
          orgSpendLimitText.test(reason) || orgSpendLimitText.test(limitMessage ?? "")
            ? { kind: "org_spend", message }
            : { kind: "usage", message, reset: resetAt === null ? null : { at: resetAt, autoResume: false } },
      }
    }
    return { type: "turn_failed", message }
  }
  return { type: "turn_completed", usage: toUsage(result, state) }
}

function toUsage(result: SDKResultMessage, state: MapState): TokenUsage {
  const usage = result.usage
  const request = state.lastRequest
  const maxTokens = request === null ? undefined : result.modelUsage[request.model]?.contextWindow
  return {
    inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    costUsd: result.total_cost_usd,
    ...(request !== null && maxTokens !== undefined && { context: { usedTokens: request.usedTokens, maxTokens } }),
  }
}
