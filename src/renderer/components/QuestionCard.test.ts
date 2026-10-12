import { describe, expect, test } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { QuestionRequest } from "../../shared/agent.ts"
import { answerText, QuestionRequestCard } from "./QuestionCard.tsx"

describe("question card identifiers", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    test(`renders the provider's ${id} question identifier`, () => {
      const request: QuestionRequest = {
        id: "request",
        threadId: "thread",
        provider: "codex",
        questions: [
          {
            id,
            header: "Question",
            question: "Choose an answer",
            options: [],
            allowsText: true,
            multiSelect: false,
            secret: false,
          },
        ],
      }
      const html = renderToStaticMarkup(createElement(QuestionRequestCard, { request, providerLabel: "Codex" }))
      expect(html).toContain("Choose an answer")
      expect(html).toContain("Skip")
    })
  }
})

describe("posted question answer text", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    const question = {
      id,
      header: "Question",
      question: "Choose an answer",
      options: [],
      allowsText: true,
      multiSelect: false,
      secret: false,
    }
    test(`formats a skipped ${id} question`, () => {
      expect(answerText([question], {})).toBe("Choose an answer\n(skipped)")
    })
    test(`formats option and typed answers for ${id}`, () => {
      for (const answer of ["blue", "green"]) {
        expect(answerText([question], { [id]: [answer] })).toBe(`Choose an answer\n${answer}`)
      }
    })
  }
})
