import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type AgentCommand,
  type AgentEvent,
  type BackgroundTask,
  type ContextBreakdown,
  type RunTurnInput,
  unlistedModel,
} from "../../../shared/agent.ts"
import { AgentError, type BackgroundTasksChange } from "../provider.ts"
import {
  usageLimitAssistant,
  usageLimitResult,
  rejectedRateLimit,
  usageLimitSessionId,
  orgSpendLimitMessage,
} from "./fixtures/usageLimit.ts"
import { artifactTurn, documentTurn, type MockDocument, publishArtifact } from "./fixtures/artifacts.ts"
import { mockModel } from "./fixtures/sdk.ts"
import {
  approvals,
  compaction,
  everything,
  failure,
  finished,
  signedOut,
  stoppable,
  thinkingStream,
  toolKinds,
  toolStates,
} from "./fixtures/transcript.ts"
import markdownFixture from "./fixtures/markdown.md?raw"
import { mockSubagents } from "./fixtures/subagents.ts"
import { ClaudeProvider } from "./index.ts"
import { mapMessage, type MapState } from "./mapMessage.ts"
import { type ApprovalReply, type MockStep, play } from "./play.ts"

export const mockScenarioDescriptions = {
  everything: "Walk through every tool kind and state, thinking, compaction, approvals and a question.",
  tools: "Call every tool the transcript renders specially, a sub-agent and an artifact.",
  "tool-states": "End tools in each state: slow, long output, empty, failed, image and MCP error.",
  thinking: "Stream a thinking block, then a Markdown reply.",
  compaction: "Compact the context once, then fail a second compaction.",
  approvals: "Ask four approvals and a question. Allow or deny each one.",
  error: "Fail the turn with an API error.",
  "signed-out": "Fail the turn because the Claude login expired.",
  stop: "Keep a command and a reply running until you press Stop.",
  "usage-limit": "Hit the plan usage limit. The next attempt succeeds.",
  "org-spend-limit": "Hit the organization monthly spend limit.",
  todos: "Create three tasks. The next message completes them.",
  markdown: "Answer with every Markdown construct the transcript renders.",
  stream: "Stream thinking, six reads and a long reply quickly.",
  activity: "Start background shells, a sub-agent and tasks, then wait for Stop.",
  "long-turn": "Replay 400 steps, then stream until Stop.",
  subagents: "Run six sub-agents that report progress every two seconds.",
  artifacts: "Publish an artifact named after the prompt.",
  documents: "Publish a document named after the prompt. The next message updates it from the version it last saw.",
} as const satisfies Record<string, string>
export type MockScenario = keyof typeof mockScenarioDescriptions
export const mockScenarios = Object.keys(mockScenarioDescriptions) as ReadonlyArray<MockScenario>

const isMockScenario = (name: string): name is MockScenario => Object.hasOwn(mockScenarioDescriptions, name)

const MOCK_COMMAND = /^\/mock-([a-z-]+)\b/

export const scenarioOf = (prompt: string, fallback: MockScenario): MockScenario => {
  const named = MOCK_COMMAND.exec(prompt.trim())?.[1]
  return named !== undefined && isMockScenario(named) ? named : fallback
}

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
    name: "code-review",
    description: "Review the changes on this branch.",
    argumentHint: "<branch>",
    scope: "user",
  },
  {
    trigger: "/",
    name: "compact",
    description: "Free up context by summarizing the conversation so far",
    argumentHint: "<optional custom summarization instructions>",
    builtin: true,
  },
  ...mockScenarios.map((scenario): AgentCommand => ({
    trigger: "/",
    name: `mock-${scenario}`,
    description: mockScenarioDescriptions[scenario],
    argumentHint: "",
    builtin: true,
  })),
]

const toolCall = (callId: string, name: string, input: unknown, output: string): Array<AgentEvent> => [
  { type: "tool_call_started", callId, name, input },
  { type: "tool_call_finished", callId, output, isError: false },
]

const chunks = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []

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

const longTurn = (): Array<AgentEvent> =>
  Array.from({ length: 400 }, (_, index): Array<AgentEvent> => [
    { type: "reasoning_delta", text: `Step ${index}. ${markdownFixture.slice(0, 400)}` },
    ...toolCall(
      `long-bash-${index}`,
      "Bash",
      { command: `pnpm vitest run step-${index}.test.ts`, description: `Run step ${index}` },
      markdownFixture.repeat(3).slice(0, 4000),
    ),
    ...(index % 16 === 0 ? [{ type: "text_delta", text: `Step ${index} passes.\n\n` } satisfies AgentEvent] : []),
  ]).flat()

const activityShells = (): Array<BackgroundTask> => [
  { id: "shell-1", kind: "shell", label: "Start the dev server", startedAt: new Date().toISOString() },
  { id: "shell-2", kind: "shell", label: "Watch the unit tests", startedAt: new Date().toISOString() },
]

const contextBreakdown: ContextBreakdown = {
  usedTokens: 142_000,
  maxTokens: 200_000,
  categories: [
    { name: "System prompt", tokens: 6_200, kind: "used" },
    { name: "System tools", tokens: 14_800, kind: "used" },
    { name: "MCP tools", tokens: 9_400, kind: "used" },
    { name: "Messages", tokens: 111_600, kind: "used" },
    { name: "Free space", tokens: 25_000, kind: "free" },
    { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
  ],
}

const playedSteps = {
  everything: () => [...everything(), finished()],
  tools: () => [...toolKinds(), finished()],
  "tool-states": () => [...toolStates(), finished()],
  thinking: () => [...thinkingStream(), finished()],
  compaction: () => [...compaction(), finished()],
  approvals: () => [...approvals(), finished()],
  error: failure,
  "signed-out": signedOut,
  stop: stoppable,
} satisfies Partial<Record<MockScenario, () => ReadonlyArray<MockStep>>>

const awaitReply = <A>(replies: Map<string, Deferred.Deferred<A>>, id: string) => {
  const pending = Deferred.makeUnsafe<A>()
  replies.set(id, pending)
  return Deferred.await(pending)
}

const reply = <A>(replies: Map<string, Deferred.Deferred<A>>, id: string, value: A) => {
  const pending = replies.get(id)
  replies.delete(id)
  return pending === undefined ? Effect.succeed(false) : Deferred.succeed(pending, value)
}

const isPlayed = (scenario: MockScenario): scenario is keyof typeof playedSteps => Object.hasOwn(playedSteps, scenario)

export const usageLimitLayer = (defaultScenario: MockScenario = "usage-limit", resetAfterMs = 60000) =>
  Layer.effect(
    ClaudeProvider,
    Effect.gen(function* () {
      const attempted = new Set<string>()
      const artifacts = new Map<string, string>()
      const documents = new Map<string, MockDocument>()
      const shells = new Map<string, ReadonlyArray<BackgroundTask>>()
      const shellChanges = yield* Queue.unbounded<BackgroundTasksChange>()
      const stopped = new Map<string, Deferred.Deferred<void>>()
      const subagentTurns = new Map<
        string,
        { readonly stop: (id: string, at: number) => Array<AgentEvent>; readonly pushed: Queue.Queue<AgentEvent> }
      >()
      const approvalReplies = new Map<string, Deferred.Deferred<ApprovalReply>>()
      const questionReplies = new Map<string, Deferred.Deferred<void>>()
      let artifactCalls = 0
      const setShells = (threadId: string, tasks: ReadonlyArray<BackgroundTask>) => {
        shells.set(threadId, tasks)
        Queue.offerUnsafe(shellChanges, { threadId, tasks })
      }
      const interrupted: AgentEvent = { type: "turn_failed", message: "Interrupted" }
      const untilStopped = (stop: Deferred.Deferred<void>) => Deferred.await(stop).pipe(Effect.as(interrupted))

      const usageLimitTurn = (input: RunTurnInput, scenario: "usage-limit" | "org-spend-limit") => {
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
          home: null,
          limitMessage: null,
          limitResetAt: null,
          signedOut: false,
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
          { ...rejectedRateLimit, rate_limit_info: { ...rejectedRateLimit.rate_limit_info, resetsAt } },
          {
            ...usageLimitAssistant,
            message: { ...usageLimitAssistant.message, content: [{ type: "text", text: message, citations: [] }] },
          },
          { ...usageLimitResult, result: message },
        ]
        const events: Array<AgentEvent> = [
          { type: "session_bound", providerSessionId: usageLimitSessionId },
          ...sdkMessages.flatMap((sdkMessage) => mapMessage(sdkMessage, state, new Date().toISOString())),
        ]
        return Stream.fromIterable(events)
      }

      const runScenario = (
        scenario: MockScenario,
        input: RunTurnInput,
        stop: Deferred.Deferred<void>,
      ): Stream.Stream<AgentEvent> => {
        if (isPlayed(scenario)) {
          return play(playedSteps[scenario](), {
            threadId: input.threadId,
            stopped: stop,
            sleep: (ms) => Effect.sleep(ms),
            approve: (request) => awaitReply(approvalReplies, request.id),
            answer: (request) => awaitReply(questionReplies, request.id),
            publishArtifact: (args) => publishArtifact(input.mcpServer, args),
          })
        }
        switch (scenario) {
          case "usage-limit":
          case "org-spend-limit":
            return usageLimitTurn(input, scenario)
          case "activity":
            setShells(input.threadId, activityShells())
            return Stream.concat(Stream.fromIterable(activityTurn()), Stream.fromEffect(untilStopped(stop)))
          case "subagents": {
            const turn = mockSubagents(Date.now())
            const progress = Stream.tick("2 seconds").pipe(
              Stream.drop(1),
              Stream.flatMap(() => Stream.fromIterable(turn.tick(Date.now()))),
            )
            return Stream.unwrap(
              Effect.map(Queue.unbounded<AgentEvent>(), (pushed) => {
                subagentTurns.set(input.threadId, { stop: turn.stop, pushed })
                return Stream.fromIterable(turn.initial).pipe(
                  Stream.concat(
                    Stream.merge(progress, Stream.fromQueue(pushed)).pipe(Stream.interruptWhen(Deferred.await(stop))),
                  ),
                  Stream.concat(Stream.make(interrupted)),
                )
              }),
            )
          }
          case "long-turn": {
            const streaming = Stream.tick("100 millis").pipe(
              Stream.map((): AgentEvent => ({ type: "text_delta", text: "streaming " })),
              Stream.interruptWhen(Deferred.await(stop)),
            )
            return Stream.fromIterable(longTurn()).pipe(
              Stream.concat(streaming),
              Stream.concat(Stream.make(interrupted)),
            )
          }
          case "artifacts": {
            const { started, finished: published } = artifactTurn(
              `mock-artifact-${++artifactCalls}`,
              input.prompt,
              input.mcpServer,
              artifacts.get(input.threadId),
              (id) => artifacts.set(input.threadId, id),
            )
            const bound: AgentEvent = { type: "session_bound", providerSessionId: `mock-artifacts-${input.threadId}` }
            return Stream.concat(Stream.make(bound, started), Stream.fromIterableEffect(published))
          }
          case "documents": {
            const { started, finished: published } = documentTurn(
              `mock-document-${++artifactCalls}`,
              input.prompt,
              input.mcpServer,
              documents.get(input.threadId),
              (document) => documents.set(input.threadId, document),
            )
            const bound: AgentEvent = { type: "session_bound", providerSessionId: `mock-documents-${input.threadId}` }
            return Stream.concat(Stream.make(bound, started), Stream.fromIterableEffect(published))
          }
          case "markdown":
            return Stream.fromIterable(markdownTurn())
          case "stream":
            return Stream.fromIterable(streamTurn()).pipe(Stream.tap(() => Effect.sleep("20 millis")))
          case "todos": {
            const first = !attempted.has(input.threadId)
            attempted.add(input.threadId)
            return Stream.fromIterable(todoTurn(first))
          }
        }
      }

      return ClaudeProvider.of({
        id: "claude",
        listModels: Effect.succeed([unlistedModel(mockModel, "claude")]),
        account: () =>
          Effect.succeed({
            type: "subscription",
            email: "dev@example.com",
            plan: "Claude Max",
            organization: "Example Org",
          }),
        planLimits: (home) =>
          Effect.succeed(
            defaultScenario === "usage-limit"
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
            const stop = Deferred.makeUnsafe<void>()
            stopped.set(input.threadId, stop)
            return runScenario(scenarioOf(input.prompt, defaultScenario), input, stop)
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
        contextBreakdown: () => Effect.succeed(contextBreakdown),
        stopSubagent: (threadId, subagentId) =>
          Effect.sync(() => {
            const turn = subagentTurns.get(threadId)
            for (const event of turn?.stop(subagentId, Date.now()) ?? []) Queue.offerUnsafe(turn!.pushed, event)
          }),
        steer: () => Effect.fail(new AgentError({ provider: "claude", message: "No turn is running on this thread" })),
        interrupt: (threadId) => {
          const stop = stopped.get(threadId)
          return stop === undefined ? Effect.void : Deferred.succeed(stop, undefined).pipe(Effect.asVoid)
        },
        respondApproval: (id, decision, note) =>
          reply(approvalReplies, id, note === undefined ? { decision } : { decision, note }).pipe(
            Effect.as(decision === "deny" && note !== undefined),
          ),
        respondQuestion: (id) => reply(questionReplies, id, undefined).pipe(Effect.asVoid),
        setAccessMode: () => Effect.void,
      })
    }),
  )
