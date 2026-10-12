import { describe, expect, test } from "@effect/vitest"
import { Effect } from "effect"
import type { AgentEvent, QuestionRequest } from "../../../shared/agent.ts"
import { makeQuestions } from "./questions.ts"

const input = {
  questions: [
    { question: "Which color?", header: "Color", options: [{ label: "blue", description: "Cool" }] },
    { question: "Which pets?", header: "Pets", options: [], multiSelect: true },
  ],
}

const setup = () => {
  const events: Array<AgentEvent> = []
  const questions = makeQuestions((_session, event) => events.push(event))
  const session = { threadId: "thread", turn: {} }
  const abort = new AbortController()
  const options = { signal: abort.signal, toolUseID: "tool-use" }
  const request = (): QuestionRequest => {
    const event = events.find((event) => event.type === "question_requested")
    if (event?.type !== "question_requested") throw new Error("No question request")
    return event.request
  }
  return { events, questions, session, abort, options, request }
}

describe("Claude questions", () => {
  test("does not request an answer for a tool call that was already aborted", async () => {
    const state = setup()
    state.abort.abort()
    const result = state.questions.ask(state.session, input, state.options)
    try {
      expect(state.events).toStrictEqual([])
      expect((await result).behavior).toBe("deny")
    } finally {
      for (const event of state.events) {
        if (event.type === "question_requested") await Effect.runPromise(state.questions.respond(event.request.id, {}))
      }
      await result
    }
  })

  test("decodes questions and returns option and free-text answers in the SDK's input", async () => {
    const state = setup()
    const result = state.questions.ask(state.session, input, state.options)
    const request = state.request()
    expect(request).toMatchObject({
      threadId: "thread",
      provider: "claude",
      questions: [
        { id: "Which color?", multiSelect: false, allowsText: true },
        { id: "Which pets?", multiSelect: true, allowsText: true },
      ],
    })
    await Effect.runPromise(
      state.questions.respond(request.id, { "Which color?": ["blue"], "Which pets?": ["cat", "hamster"] }),
    )
    expect(await result).toStrictEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which color?": "blue", "Which pets?": "cat, hamster" } },
    })
    expect(state.events.at(-1)).toStrictEqual({ type: "question_resolved", requestId: request.id })
  })

  test("skip and in-flight abort both resolve the pending card", async () => {
    for (const action of ["skip", "abort"]) {
      const state = setup()
      const result = state.questions.ask(state.session, input, state.options)
      const request = state.request()
      if (action === "abort") state.abort.abort()
      else await Effect.runPromise(state.questions.respond(request.id, {}))
      expect(await result).toStrictEqual({ behavior: "deny", message: "The user skipped these questions" })
      expect(state.events.at(-1)).toStrictEqual({ type: "question_resolved", requestId: request.id })
      await Effect.runPromise(state.questions.respond(request.id, { "Which color?": ["late"] }))
    }
  })

  test("denies malformed input before raising a question card", async () => {
    const state = setup()
    expect(await state.questions.ask(state.session, { questions: [{ question: 1 }] }, state.options)).toMatchObject({
      behavior: "deny",
    })
    expect(state.events).toStrictEqual([])
  })
})
