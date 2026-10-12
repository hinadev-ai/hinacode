import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitEvent,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk"

export const usageLimitMessage = "You've hit your limit · resets 3pm (Asia/Tokyo)"
export const orgSpendLimitMessage =
  "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 2:10pm (Asia/Tokyo)"
export const usageLimitSessionId = "usage-limit-session"

export const rejectedRateLimit: SDKRateLimitEvent = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1791784800 },
  uuid: "b9b64872-1dd4-4a72-b570-b6e469a2cd27",
  session_id: usageLimitSessionId,
}

export const usageLimitResult: SDKResultSuccess = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: usageLimitMessage,
  duration_ms: 0,
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: "not_available",
    iterations: [],
    speed: "standard",
    fallback_credit: null,
    output_tokens_details: { thinking_tokens: 0 },
  },
  modelUsage: {},
  permission_denials: [],
  uuid: "8f571b36-b6a9-4e80-a63c-d04254c94f29",
  session_id: usageLimitSessionId,
}

export const usageLimitAssistant: SDKAssistantMessage = {
  type: "assistant",
  error: "rate_limit",
  parent_tool_use_id: null,
  uuid: "7b762f71-a764-4434-81ab-8b3c095fed14",
  session_id: usageLimitSessionId,
  message: {
    id: "msg_usage_limit",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: usageLimitMessage, citations: [] }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: usageLimitResult.usage,
  },
}

export const usageLimitMessages: ReadonlyArray<SDKMessage> = [rejectedRateLimit, usageLimitAssistant, usageLimitResult]
