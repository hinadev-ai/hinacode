import { randomUUID } from "node:crypto"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Option, Schema } from "effect"
import type { AgentEvent, Question, QuestionAnswers } from "../../../shared/agent.ts"

export const QUESTION_TOOL = "AskUserQuestion"

interface QuestionSession {
  readonly threadId: string
  readonly turn: object | null
}

const AskUserQuestionInput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      multiSelect: Schema.optional(Schema.Boolean),
    }),
  ),
})
const decodeInput = Schema.decodeUnknownOption(AskUserQuestionInput)

/** The CLI keys answers by question text, and so do we. */
const toQuestion = (question: (typeof AskUserQuestionInput.Type)["questions"][number]): Question => ({
  id: question.question,
  header: question.header,
  question: question.question,
  options: question.options,
  multiSelect: question.multiSelect ?? false,
  allowsText: true,
  secret: false,
})

/** Answers `AskUserQuestion` through `canUseTool`: the CLI reads the user's choices from `updatedInput.answers`. */
export function makeQuestions<S extends QuestionSession>(emit: (session: S, event: AgentEvent) => void) {
  const pending = new Map<string, Deferred.Deferred<QuestionAnswers>>()

  const ask = async (
    session: S,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> => {
    if (session.turn === null) return { behavior: "deny", message: "No active turn to ask the user in" }
    const decoded = decodeInput(input)
    if (Option.isNone(decoded)) return { behavior: "deny", message: "kkcode could not read these questions" }

    const requestId = randomUUID()
    const deferred = Deferred.makeUnsafe<QuestionAnswers>()
    pending.set(requestId, deferred)
    const onAbort = () => Deferred.doneUnsafe(deferred, Effect.succeed({}))
    options.signal.addEventListener("abort", onAbort, { once: true })
    emit(session, {
      type: "question_requested",
      request: {
        id: requestId,
        threadId: session.threadId,
        provider: "claude",
        questions: decoded.value.questions.map(toQuestion),
      },
    })

    const answers = await Effect.runPromise(Deferred.await(deferred))
    options.signal.removeEventListener("abort", onAbort)
    pending.delete(requestId)
    emit(session, { type: "question_resolved", requestId })
    const answered = Object.entries(answers).filter(([, values]) => values.length > 0)
    if (answered.length === 0) return { behavior: "deny", message: "The user skipped these questions" }
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: Object.fromEntries(answered.map(([id, values]) => [id, values.join(", ")])) },
    }
  }

  const respond = (requestId: string, answers: QuestionAnswers) =>
    Effect.suspend(() => {
      const deferred = pending.get(requestId)
      return deferred === undefined ? Effect.void : Deferred.succeed(deferred, answers)
    }).pipe(Effect.asVoid)

  return { ask, respond }
}
