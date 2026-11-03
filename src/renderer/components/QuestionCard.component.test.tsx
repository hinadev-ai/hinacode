import { expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Question, QuestionAnswers } from "../../shared/agent.ts"
import "../index.css"
import { QuestionRequestCard } from "./QuestionCard.tsx"

let responded: QuestionAnswers | null = null

const bridge: HinacodeBridge = {
  rpc: async (method, request) => {
    if (method !== "questions.respond") return { error: { tag: "NotStubbed", message: method } }
    responded = (request as { answers: QuestionAnswers }).answers
    return { result: null }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const question = (id: string, header: string, text: string, options: ReadonlyArray<string>): Question => ({
  id,
  header,
  question: text,
  options: options.map((label) => ({ label, description: "" })),
  multiSelect: false,
  allowsText: true,
  secret: false,
})

const questions = [
  question("branch", "Branch", "Which branch should I use?", ["main", "develop"]),
  question("tests", "Tests", "Should I run the tests?", ["Yes", "No"]),
  question("name", "", "What should the release be called?", []),
]

const renderCard = () => {
  responded = null
  return render(
    <QuestionRequestCard
      request={{ id: "request", threadId: "thread", provider: "claude", questions }}
      providerLabel="Claude"
    />,
  )
}

test("shows only the first question", async () => {
  await renderCard()
  await expect.element(page.getByText("Which branch should I use?")).toBeVisible()
  expect(page.getByText("Should I run the tests?").query()).toBeNull()
  await expect.element(page.getByRole("button", { name: "Branch" })).toHaveAttribute("aria-current", "step")
  await expect.element(page.getByText("Question 1 of 3")).toBeInTheDocument()
  expect(page.getByRole("button", { name: "Submit" }).query()).toBeNull()
  expect(page.getByRole("button", { name: "Back" }).query()).toBeNull()
})

test("Next shows the second question and Back keeps the earlier answer", async () => {
  await renderCard()
  await page.getByRole("textbox").fill("release/1.0")
  await page.getByRole("button", { name: "Next" }).click()
  await expect.element(page.getByText("Should I run the tests?")).toBeVisible()
  expect(page.getByText("Which branch should I use?").query()).toBeNull()
  await expect.element(page.getByRole("button", { name: "Branch Answered" })).toBeInTheDocument()

  await page.getByRole("button", { name: "Back" }).click()
  await expect.element(page.getByRole("textbox")).toHaveValue("release/1.0")
})

test("Enter on a step before the last advances instead of submitting", async () => {
  await renderCard()
  await page.getByRole("textbox").fill("release/1.0")
  await userEvent.keyboard("{Enter}")
  await expect.element(page.getByText("Should I run the tests?")).toBeVisible()
  expect(responded).toBeNull()
})

test("picking a single-select option with the pointer advances", async () => {
  await renderCard()
  await page.getByText("develop").click()
  await expect.element(page.getByText("Should I run the tests?")).toBeVisible()
  await page.getByRole("button", { name: "Back" }).click()
  await expect.element(page.getByRole("radio", { name: "develop" })).toBeChecked()
})

test("moving through options with the keyboard does not advance", async () => {
  await renderCard()
  await page.getByRole("radio", { name: "main" }).element().focus()
  await userEvent.keyboard(" ")
  await expect.element(page.getByRole("radio", { name: "main" })).toBeChecked()
  await userEvent.keyboard("{ArrowDown}")
  await expect.element(page.getByRole("radio", { name: "develop" })).toBeChecked()
  await expect.element(page.getByText("Which branch should I use?")).toBeVisible()
})

test("Submit on the last step answers every question by id", async () => {
  await renderCard()
  await page.getByText("develop").click()
  await page.getByText("Yes").click()
  await expect.element(page.getByText("Questions left blank are skipped.")).toBeVisible()
  await page.getByRole("textbox").fill("Spring")
  await page.getByRole("button", { name: "Submit" }).click()
  await expect.poll(() => responded).toEqual({ branch: ["develop"], tests: ["Yes"], name: ["Spring"] })
})
