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
import markdownFixture from "./fixtures/markdown.md?raw"
import { ClaudeProvider } from "./index.ts"
import { mapMessage, type MapState } from "./mapMessage.ts"

export type MockScenario = "usage-limit" | "org-spend-limit" | "todos" | "markdown"

const toolCall = (callId: string, name: string, input: unknown, output: string): Array<AgentEvent> => [
  { type: "tool_call_started", callId, name, input },
  { type: "tool_call_finished", callId, output, isError: false },
]

/** Every turn replies with a fixture of each Markdown construct, in chunks like a streamed reply. */
const markdownTurn = (): Array<AgentEvent> => [
  ...(markdownFixture.match(/[\s\S]{1,400}/g) ?? []).map((text): AgentEvent => ({ type: "text_delta", text })),
  { type: "turn_completed" },
]

/**
 * A turn that plans three tasks and starts the second, then a follow-up that finishes the list.
 * Inputs and outputs match a real Claude Code transcript, so the composer's task list folds the
 * same calls it would see from the CLI.
 */
const todoTurn = (first: boolean): Array<AgentEvent> =>
  first
    ? [
        { type: "session_bound", providerSessionId: usageLimitSessionId },
        ...toolCall(
          "todo-create-1",
          "TaskCreate",
          {
            subject: "Read README.md",
            description: "Read README.md in the working directory",
            activeForm: "Reading README.md",
          },
          "Task #1 created successfully: Read README.md",
        ),
        ...toolCall(
          "todo-create-2",
          "TaskCreate",
          {
            subject: "Read math.js",
            description: "Read math.js in the working directory",
            activeForm: "Reading math.js",
          },
          "Task #2 created successfully: Read math.js",
        ),
        ...toolCall(
          "todo-create-3",
          "TaskCreate",
          { subject: "Summarize", description: "Give a one-line summary of both files", activeForm: "Summarizing" },
          "Task #3 created successfully: Summarize",
        ),
        ...toolCall("todo-update-1", "TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status"),
        ...toolCall("todo-update-2", "TaskUpdate", { taskId: "2", status: "in_progress" }, "Updated task #2 status"),
        { type: "text_delta", text: "One task done, two to go." },
        { type: "turn_completed" },
      ]
    : [
        ...toolCall("todo-update-3", "TaskUpdate", { taskId: "2", status: "completed" }, "Updated task #2 status"),
        ...toolCall("todo-update-4", "TaskUpdate", { taskId: "3", status: "completed" }, "Updated task #3 status"),
        { type: "text_delta", text: "All tasks are done." },
        { type: "turn_completed" },
      ]

export const usageLimitLayer = (scenario: MockScenario = "usage-limit", resetAfterMs = 60000) =>
  Layer.effect(
    ClaudeProvider,
    Effect.sync(() => {
      const attempted = new Set<string>()
      return ClaudeProvider.of({
        id: "claude",
        listModels: Effect.succeed([unlistedModel("claude-sonnet-5-5", "claude")]),
        account: () =>
          Effect.succeed({
            type: "subscription",
            email: "dev@example.com",
            plan: "Claude Max",
            organization: "Example Org",
          }),
        planLimits: () => Effect.succeed(null),
        usage: () => Effect.succeed(null),
        listCommands: () => Effect.succeed([]),
        runTurn: (input) =>
          Stream.suspend(() => {
            if (scenario === "markdown") return Stream.fromIterable(markdownTurn())
            if (scenario === "todos") {
              const first = !attempted.has(input.threadId)
              attempted.add(input.threadId)
              return Stream.fromIterable(todoTurn(first))
            }
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
