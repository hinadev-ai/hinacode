import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Stream } from "effect"
import type { AgentEvent, ApprovalDecision, ApprovalRequest, Question, QuestionRequest } from "../../../shared/agent.ts"
import { mockModel, nextCallId, toolResult, toolUse } from "./fixtures/sdk.ts"
import { interruptedTurn } from "../provider.ts"
import { mapMessage, type MapState } from "./mapMessage.ts"

export type MockStep =
  | { readonly type: "sdk"; readonly message: SDKMessage }
  | { readonly type: "pause"; readonly ms: number }
  | {
      readonly type: "approval"
      readonly callId: string
      readonly request: Pick<ApprovalRequest, "kind" | "title" | "detail" | "input" | "sessionScope">
      readonly output: string
    }
  | { readonly type: "question"; readonly questions: ReadonlyArray<Question> }
  | {
      readonly type: "mcp"
      readonly name: string
      readonly input: Record<string, unknown>
      readonly next?: (result: McpResult) => ReadonlyArray<MockStep>
    }
  | { readonly type: "until_stopped" }

export interface McpResult {
  readonly output: string
  readonly isError: boolean
}

export interface ApprovalReply {
  readonly decision: ApprovalDecision
  readonly note?: string
}

export interface PlayControls {
  readonly threadId: string
  readonly stopped: Deferred.Deferred<void>
  readonly sleep: (ms: number) => Effect.Effect<void>
  readonly approve: (request: ApprovalRequest) => Effect.Effect<ApprovalReply>
  readonly answer: (request: QuestionRequest) => Effect.Effect<void>
  readonly callTool: (name: string, input: Record<string, unknown>) => Effect.Effect<McpResult>
}

const deniedOutput = ({ note }: ApprovalReply) =>
  note === undefined ? "The user denied this tool call" : `The user denied this tool call and said: ${note}`

export function play(steps: ReadonlyArray<MockStep>, controls: PlayControls): Stream.Stream<AgentEvent> {
  const state: MapState = {
    pendingEdits: new Map(),
    subagents: new Map(),
    subagentRequests: new Map(),
    lastRequest: null,
    provider: "claude",
    home: null,
    model: mockModel,
    limitMessage: null,
    limitResetAt: null,
    signedOut: false,
  }
  const map = (message: SDKMessage) => mapMessage(message, state, new Date().toISOString())
  let requests = 0

  const run = (step: MockStep): Stream.Stream<AgentEvent> => {
    switch (step.type) {
      case "sdk":
        return Stream.fromIterable(map(step.message))
      case "pause":
        return Stream.fromEffectDrain(controls.sleep(step.ms))
      case "approval": {
        const request: ApprovalRequest = {
          ...step.request,
          id: `mock-approval-${controls.threadId}-${++requests}`,
          threadId: controls.threadId,
          provider: "claude",
        }
        const resolved = controls.approve(request).pipe(
          Effect.map((reply): ReadonlyArray<AgentEvent> => {
            const denied = reply.decision === "deny"
            const result = toolResult(step.callId, denied ? deniedOutput(reply) : step.output, { isError: denied })
            return [{ type: "approval_resolved", requestId: request.id }, ...map(result)]
          }),
        )
        return Stream.concat(
          Stream.succeed<AgentEvent>({ type: "approval_requested", request }),
          Stream.fromIterableEffect(resolved),
        )
      }
      case "question": {
        const request: QuestionRequest = {
          id: `mock-question-${controls.threadId}-${++requests}`,
          threadId: controls.threadId,
          provider: "claude",
          questions: step.questions,
        }
        return Stream.concat(
          Stream.succeed<AgentEvent>({ type: "question_requested", request }),
          Stream.fromEffect(
            controls.answer(request).pipe(Effect.as<AgentEvent>({ type: "question_resolved", requestId: request.id })),
          ),
        )
      }
      case "mcp": {
        const callId = nextCallId()
        const called = controls
          .callTool(step.name, step.input)
          .pipe(
            Effect.map((result) =>
              Stream.concat(
                Stream.fromIterable(map(toolResult(callId, result.output, { isError: result.isError }))),
                Stream.fromIterable(step.next?.(result) ?? []).pipe(Stream.flatMap(run)),
              ),
            ),
          )
        return Stream.concat(
          Stream.fromIterable(map(toolUse(callId, `mcp__hinacode__${step.name}`, step.input))),
          Stream.unwrap(called),
        )
      }
      case "until_stopped":
        return Stream.fromEffectDrain(Deferred.await(controls.stopped))
    }
  }

  const interrupted = Stream.unwrap(
    Deferred.isDone(controls.stopped).pipe(
      Effect.map((stopped) => (stopped ? Stream.succeed(interruptedTurn) : Stream.empty)),
    ),
  )
  return Stream.fromIterable(steps).pipe(
    Stream.flatMap(run),
    Stream.interruptWhen(Deferred.await(controls.stopped)),
    Stream.concat(interrupted),
  )
}
