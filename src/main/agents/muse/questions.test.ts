import { describe, expect, test } from "@effect/vitest"
import { toAnswers, toQuestion } from "./questions.ts"
import type { UserInputQuestion } from "./protocol.ts"

const color: UserInputQuestion = {
  id: "color",
  header: "Color",
  question: "Which color?",
  options: [{ label: "Blue", description: "Cool" }, { label: "Red" }],
  selection: { mode: "single" },
}
const toppings: UserInputQuestion = {
  id: "toppings",
  header: "Toppings",
  question: "Which toppings?",
  options: [{ label: "Cheese" }, { label: "Basil" }],
  selection: { mode: "multiple", minSelections: 1, maxSelections: 2 },
}

describe("toQuestion", () => {
  test("keeps the options, allows typed text and marks multiple selection", () => {
    expect(toQuestion(color)).toStrictEqual({
      id: "color",
      header: "Color",
      question: "Which color?",
      options: [
        { label: "Blue", description: "Cool" },
        { label: "Red", description: "" },
      ],
      multiSelect: false,
      allowsText: true,
      secret: false,
    })
    expect(toQuestion(toppings).multiSelect).toBe(true)
  })
})

describe("toAnswers", () => {
  test("answers a picked option by label, and picked options by labels", () => {
    expect(toAnswers([color, toppings], { color: ["Red"], toppings: ["Cheese", "Basil"] })).toStrictEqual([
      { questionId: "color", selectedLabel: "Red" },
      { questionId: "toppings", selectedLabels: ["Cheese", "Basil"] },
    ])
  })

  test("sends typed text as free text, lines joined and cut at 500 characters", () => {
    expect(toAnswers([color], { color: ["Green"] })).toStrictEqual([{ questionId: "color", freeText: "Green" }])
    expect(toAnswers([toppings], { toppings: ["Cheese", "Olives"] })).toStrictEqual([
      { questionId: "toppings", freeText: "Cheese\nOlives" },
    ])
    expect(toAnswers([color], { color: ["x".repeat(600)] })?.[0]?.freeText).toHaveLength(500)
  })

  test("tells the model a question was skipped when another was answered", () => {
    expect(toAnswers([color, toppings], { color: ["Blue"] })).toStrictEqual([
      { questionId: "color", selectedLabel: "Blue" },
      { questionId: "toppings", freeText: "Skipped" },
    ])
  })

  test("is null when every question was skipped", () => {
    expect(toAnswers([color, toppings], {})).toBeNull()
    expect(toAnswers([color], { color: [] })).toBeNull()
  })
})
