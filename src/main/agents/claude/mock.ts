import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { type AgentCommand, type AgentEvent, type BackgroundTask, unlistedModel } from "../../../shared/agent.ts"
import { AgentError, type BackgroundTasksChange } from "../provider.ts"
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

export const mockScenarios = ["usage-limit", "org-spend-limit", "todos", "markdown", "stream", "activity"] as const
export type MockScenario = (typeof mockScenarios)[number]

/** A skill and one of Claude Code's own commands, which the composer shows differently. */
const commands: ReadonlyArray<AgentCommand> = [
  {
    trigger: "/",
    name: "triage-issue",
    description: "Reproduce a reported bug and find its cause.",
    argumentHint: "",
    scope: "project",
  },
  {
    trigger: "/",
    name: "compact",
    description: "Free up context by summarizing the conversation so far",
    argumentHint: "<optional custom summarization instructions>",
    builtin: true,
  },
]

const toolCall = (callId: string, name: string, input: unknown, output: string): Array<AgentEvent> => [
  { type: "tool_call_started", callId, name, input },
  { type: "tool_call_finished", callId, output, isError: false },
]

const chunks = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []

/** Every turn replies with a fixture of each Markdown construct, in chunks like a streamed reply. */
const markdownTurn = (): Array<AgentEvent> => [
  ...chunks(markdownFixture, 400).map((text): AgentEvent => ({ type: "text_delta", text })),
  { type: "turn_completed" },
]

const streamTurn = (): Array<AgentEvent> => [
  ...chunks(markdownFixture.slice(0, 900), 30).map((text): AgentEvent => ({ type: "reasoning_delta", text })),
  ...Array.from({ length: 6 }, (_, index) =>
    toolCall(`stream-read-${index}`, "Read", { file_path: `src/file-${index}.ts` }, markdownFixture),
  ).flat(),
  ...chunks(markdownFixture, 30).map((text): AgentEvent => ({ type: "text_delta", text })),
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

/**
 * A turn that keeps running with every kind of activity at once: a plan, a sub-agent, and two shells started with
 * `run_in_background` that outlive the turn until they are stopped.
 */
const activityTurn = (): Array<AgentEvent> => [
  ...todoTurn(true).filter((event) => event.type !== "turn_completed" && event.type !== "text_delta"),
  {
    type: "subagent_updated",
    subagent: {
      id: "agent-1",
      label: "Audit the composer",
      callId: null,
      status: "running",
      summary: "Reading Composer.tsx",
      lastTool: "Read",
      toolUses: 3,
      tokens: 1200,
      startedAt: new Date().toISOString(),
      endedAt: null,
    },
  },
  ...toolCall(
    "activity-shell-1",
    "Bash",
    { command: "pnpm dev", description: "Start the dev server", run_in_background: true },
    "Command running in background with ID: shell-1",
  ),
  ...toolCall(
    "activity-shell-2",
    "Bash",
    { command: "pnpm test --watch", description: "Watch the unit tests", run_in_background: true },
    "Command running in background with ID: shell-2",
  ),
]

const activityShells = (): Array<BackgroundTask> => [
  { id: "shell-1", kind: "shell", label: "Start the dev server", startedAt: new Date().toISOString() },
  { id: "shell-2", kind: "shell", label: "Watch the unit tests", startedAt: new Date().toISOString() },
]

export const usageLimitLayer = (scenario: MockScenario = "usage-limit", resetAfterMs = 60000) =>
  Layer.effect(
    ClaudeProvider,
    Effect.gen(function* () {
      const attempted = new Set<string>()
      const shells = new Map<string, ReadonlyArray<BackgroundTask>>()
      const shellChanges = yield* Queue.unbounded<BackgroundTasksChange>()
      const heldTurns = new Map<string, Deferred.Deferred<void>>()
      const setShells = (threadId: string, tasks: ReadonlyArray<BackgroundTask>) => {
        shells.set(threadId, tasks)
        Queue.offerUnsafe(shellChanges, { threadId, tasks })
      }
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
        // The CLI's own login has spent its 5-hour window and added accounts have room, so a switch can be tried.
        planLimits: (home) =>
          Effect.succeed(
            scenario === "usage-limit"
              ? {
                  windows: [
                    {
                      window: { kind: "session" },
                      usedPercent: home === null ? 100 : 12,
                      resetsAt: new Date(Date.now() + resetAfterMs).toISOString(),
                    },
                  ],
                  readAt: new Date().toISOString(),
                }
              : null,
          ),
        usage: () => Effect.succeed(null),
        copySession: () => Effect.void,
        listCommands: () => Effect.succeed(commands),
        runTurn: (input) =>
          Stream.suspend(() => {
            if (scenario === "activity") {
              setShells(input.threadId, activityShells())
              const interrupted = Deferred.makeUnsafe<void>()
              heldTurns.set(input.threadId, interrupted)
              const ended: AgentEvent = { type: "turn_failed", message: "Interrupted" }
              return Stream.concat(
                Stream.fromIterable(activityTurn()),
                Stream.fromEffect(Deferred.await(interrupted).pipe(Effect.as(ended))),
              )
            }
            if (scenario === "markdown") return Stream.fromIterable(markdownTurn())
            if (scenario === "stream")
              return Stream.fromIterable(streamTurn()).pipe(Stream.tap(() => Effect.sleep("20 millis")))
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
        backgroundTasks: {
          changes: Stream.fromQueue(shellChanges),
          stop: (threadId, taskId) =>
            Effect.sync(() =>
              setShells(
                threadId,
                (shells.get(threadId) ?? []).filter((task) => task.id !== taskId),
              ),
            ),
        },
        steer: () => Effect.fail(new AgentError({ provider: "claude", message: "No turn is running on this thread" })),
        interrupt: (threadId) => {
          const held = heldTurns.get(threadId)
          return held === undefined ? Effect.void : Deferred.succeed(held, undefined).pipe(Effect.asVoid)
        },
        respondApproval: () => Effect.void,
        respondQuestion: () => Effect.void,
        setAccessMode: () => Effect.void,
      })
    }),
  )
