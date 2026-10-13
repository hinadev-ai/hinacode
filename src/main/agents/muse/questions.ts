import type { Question, QuestionAnswers } from "../../../shared/agent.ts"
import type { UserInputAnswer, UserInputQuestion } from "./protocol.ts"

/** Muse caps a typed answer at 500 characters. */
const MAX_TEXT = 500

export const toQuestion = (question: UserInputQuestion): Question => ({
  id: question.id,
  header: question.header,
  question: question.question,
  options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
  multiSelect: question.selection.mode === "multiple",
  allowsText: true,
  secret: false,
})

/**
 * MSP wants exactly one answer per question: the picked label, the picked labels, or typed text. A skipped
 * question is answered in words so the model knows. Null when every question was skipped, which cancels the ask.
 */
export const toAnswers = (
  questions: ReadonlyArray<UserInputQuestion>,
  answers: QuestionAnswers,
): Array<UserInputAnswer> | null => {
  if (questions.every((question) => (answers[question.id] ?? []).length === 0)) return null
  return questions.map((question): UserInputAnswer => {
    const values = answers[question.id] ?? []
    if (values.length === 0) return { questionId: question.id, freeText: "Skipped" }
    const labels = new Set(question.options.map((option) => option.label))
    if (!values.every((value) => labels.has(value))) {
      return { questionId: question.id, freeText: values.join("\n").slice(0, MAX_TEXT) }
    }
    return question.selection.mode === "multiple"
      ? { questionId: question.id, selectedLabels: [...values] }
      : { questionId: question.id, selectedLabel: values[0] }
  })
}
