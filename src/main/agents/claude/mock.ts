import { Effect, Layer, Stream } from "effect"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { type AgentEvent, unlistedModel } from "../../../shared/agent.ts"
import { AgentError } from "../provider.ts"
import {
  usageLimitAssistant,
  usageLimitResult,
  rejectedRateLimit,
  usageLimitSessionId,
  orgSpendLimitMessage,
} from "./fixtures/usageLimit.ts"
import { ClaudeProvider } from "./index.ts"
import { mapMessage, type MapState } from "./mapMessage.ts"

export const usageLimitLayer = (scenario: "usage-limit" | "org-spend-limit" = "usage-limit", resetAfterMs = 60000) =>
  Layer.effect(
    ClaudeProvider,
    Effect.sync(() => {
      const attempted = new Set<string>()
      return ClaudeProvider.of({
        id: "claude",
        listModels: Effect.succeed([unlistedModel("claude-sonnet-5-5", "claude")]),
        account: Effect.succeed({
          type: "subscription",
          email: "dev@example.com",
          plan: "Claude Max",
          organization: "Example Org",
        }),
        usage: () => Effect.succeed(null),
        listCommands: () => Effect.succeed([]),
        runTurn: (input) =>
          Stream.suspend(() => {
            if (attempted.has(input.threadId) || input.resumeSessionId !== null) {
              const events: Array<AgentEvent> = [
                { type: "text_delta", text: "The retry completed successfully." },
                { type: "turn_completed" },
              ]
              return Stream.fromIterable(events)
            }
            attempted.add(input.threadId)
            const state: MapState = {
              pendingEdits: new Map(),
              subagents: new Map(),
              lastRequest: null,
              limitMessage: null,
              limitResetAt: null,
            }
            const resetsAt = Math.ceil((Date.now() + resetAfterMs) / 1000)
            const resetTime = new Intl.DateTimeFormat("en-US", {
              timeZone: "Asia/Tokyo",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            }).format(resetsAt * 1000)
            const message =
              scenario === "org-spend-limit"
                ? orgSpendLimitMessage
                : `You've hit your limit · resets ${resetTime} (Asia/Tokyo)`
            const sdkMessages: ReadonlyArray<SDKMessage> = [
              {
                ...rejectedRateLimit,
                rate_limit_info: {
                  ...rejectedRateLimit.rate_limit_info,
                  resetsAt,
                },
              },
              {
                ...usageLimitAssistant,
                message: {
                  ...usageLimitAssistant.message,
                  content: [{ type: "text", text: message, citations: [] }],
                },
              },
              { ...usageLimitResult, result: message },
            ]
            const events: Array<AgentEvent> = [
              { type: "session_bound", providerSessionId: usageLimitSessionId },
              ...sdkMessages.flatMap((sdkMessage) => mapMessage(sdkMessage, state, new Date().toISOString())),
            ]
            return Stream.fromIterable(events)
          }),
        steer: () => Effect.fail(new AgentError({ provider: "claude", message: "No turn is running on this thread" })),
        interrupt: () => Effect.void,
        respondApproval: () => Effect.void,
        respondQuestion: () => Effect.void,
        setAccessMode: () => Effect.void,
      })
    }),
  )
