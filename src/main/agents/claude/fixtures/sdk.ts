import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKPartialAssistantMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKStatusMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { randomUUID } from "node:crypto"

const mockSessionId = "mock-session"
export const mockModel = "claude-sonnet-5-5"
const mockContextWindow = 200_000

type Usage = SDKResultSuccess["usage"]
type ContentBlock = SDKAssistantMessage["message"]["content"][number]
type ToolResultContent = string | ReadonlyArray<{ readonly type: "text"; readonly text: string } | ImageBlock>
interface ImageBlock {
  readonly type: "image"
  readonly source: { readonly type: "base64"; readonly media_type: "image/png"; readonly data: string }
}

const envelope = () => ({ uuid: randomUUID(), session_id: mockSessionId })

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  input_tokens: 4,
  output_tokens: outputTokens,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: inputTokens,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "not_available",
  iterations: [],
  speed: "standard",
  fallback_credit: null,
  output_tokens_details: { thinking_tokens: 0 },
})

let lastCallId = 0
export const nextCallId = () => `toolu_mock_${String(++lastCallId).padStart(4, "0")}`

type Delta = Extract<SDKPartialAssistantMessage["event"], { type: "content_block_delta" }>["delta"]

const streamEvent = (delta: Delta): SDKPartialAssistantMessage => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta },
  parent_tool_use_id: null,
  ...envelope(),
})

export const textDelta = (text: string) => streamEvent({ type: "text_delta", text })

export const thinkingDelta = (thinking: string) =>
  streamEvent({ type: "thinking_delta", thinking, estimated_tokens: null })

export const assistant = (
  content: ReadonlyArray<ContentBlock>,
  { contextTokens = 24_000, parentCallId = null }: { contextTokens?: number; parentCallId?: string | null } = {},
): SDKAssistantMessage => ({
  type: "assistant",
  parent_tool_use_id: parentCallId,
  ...envelope(),
  message: {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: mockModel,
    content: [...content],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: usage(contextTokens, 120),
  },
})

export const toolUse = (id: string, name: string, input: Record<string, unknown>, parentCallId: string | null = null) =>
  assistant([{ type: "tool_use", id, name, input }], { parentCallId })

export const toolResult = (
  id: string,
  content: ToolResultContent,
  { isError = false, parentCallId = null }: { isError?: boolean; parentCallId?: string | null } = {},
): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: parentCallId,
  ...envelope(),
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: typeof content === "string" ? content : [...content],
        is_error: isError,
      },
    ],
  },
})

export const pngBlock = (data: string): ImageBlock => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data },
})

export const compacting = (): SDKStatusMessage => ({
  type: "system",
  subtype: "status",
  status: "compacting",
  ...envelope(),
})

export const compactFailed = (error: string): SDKStatusMessage => ({
  type: "system",
  subtype: "status",
  status: null,
  compact_result: "failed",
  compact_error: error,
  ...envelope(),
})

export const compactBoundary = (
  trigger: "manual" | "auto",
  preTokens: number,
  postTokens: number,
): SDKCompactBoundaryMessage => ({
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: { trigger, pre_tokens: preTokens, post_tokens: postTokens },
  ...envelope(),
})

export const taskStarted = (taskId: string, callId: string, description: string): SDKTaskStartedMessage => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: callId,
  description,
  task_type: "local_agent",
  ...envelope(),
})

export const taskEnded = (
  taskId: string,
  callId: string,
  status: SDKTaskNotificationMessage["status"],
  summary: string,
): SDKTaskNotificationMessage => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  tool_use_id: callId,
  status,
  output_file: "",
  summary,
  usage: { total_tokens: 18_400, tool_uses: 6, duration_ms: 41_000 },
  ...envelope(),
})

const resultFields = (contextTokens: number) => ({
  duration_ms: 12_000,
  duration_api_ms: 9_000,
  num_turns: 1,
  stop_reason: "end_turn",
  total_cost_usd: 0.42,
  usage: usage(contextTokens, 2_400),
  modelUsage: {
    [mockModel]: {
      inputTokens: contextTokens,
      outputTokens: 2_400,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.42,
      contextWindow: mockContextWindow,
      maxOutputTokens: 64_000,
    },
  },
  permission_denials: [],
  ...envelope(),
})

export const success = (): SDKResultSuccess => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  ...resultFields(140_000),
})

export const executionError = (error: string): SDKResultError => ({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [error],
  ...resultFields(0),
})
