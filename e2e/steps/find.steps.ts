import { expect, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import type { DataTable } from "playwright-bdd"
import type { AgentEvent } from "../../src/shared/agent.ts"
import type { PushEvent } from "../../src/shared/contract.ts"
import type { Message } from "../../src/shared/domain.ts"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const transcript = (page: Page) => page.locator("article[aria-busy]")
const findField = (page: Page) => page.getByRole("textbox", { name: "Find in thread", exact: true })
const currentMarkSelector = "mark[data-find-match][data-current]"
const currentMark = (page: Page) => transcript(page).locator(currentMarkSelector)

Given("the agent finished a turn in {string} with", async ({ app, threadIds }, title: string, table: DataTable) => {
  await expect(app.page.getByRole("heading", { name: "Start the conversation", exact: true })).toBeVisible()
  const threadId = threadIds.get(title)
  if (!threadId) throw new Error(`no seeded thread named ${title}`)
  let { seq } = await rpc(app.page, "threads.transcript", { threadId })
  const message: Message = {
    id: randomUUID(),
    threadId,
    role: "assistant",
    parts: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
    usage: null,
  }
  const push = (event: AgentEvent): PushEvent => ({ type: "thread.event", threadId, seq: ++seq, event })
  const events: Array<PushEvent> = [{ type: "message.created", seq: ++seq, message }]
  for (const [row, { kind, text = "", description = "" }] of table.hashes().entries()) {
    if (kind === "text") {
      events.push(push({ type: "text_delta", text }))
      continue
    }
    const callId = `find-command-${row}`
    const input = description === "" ? { command: text } : { command: text, description }
    events.push(
      push({ type: "tool_call_started", callId, name: "Bash", input }),
      push({ type: "tool_call_finished", callId, output: "", isError: false }),
    )
  }
  events.push(push({ type: "turn_completed" }))
  await app.pushEvents(events)
  await expect(transcript(app.page)).toHaveAttribute("aria-busy", "false")
})

When("I find {string} in the thread", async ({ app }, query: string) => {
  await app.page.keyboard.press("ControlOrMeta+f")
  await expect(findField(app.page)).toBeFocused()
  await findField(app.page).fill(query)
})

Then("Find counts {string}", async ({ app }, count: string) => {
  await expect(app.page.getByRole("search", { name: "Find in thread" }).locator("output")).toHaveText(count)
})

When("I go to the previous match", async ({ app }) => {
  await app.page.getByRole("button", { name: "Previous match", exact: true }).click()
})

When("I go to the next match", async ({ app }) => {
  await app.page.getByRole("button", { name: "Next match", exact: true }).click()
})

When("I close Find", async ({ app }) => {
  await app.page.getByRole("button", { name: "Close find", exact: true }).click()
  await expect(findField(app.page)).toBeHidden()
})

Then("the current match is in the command {string}", async ({ app }, command: string) => {
  const section = transcript(app.page)
    .locator("section")
    .filter({ has: app.page.getByRole("heading", { name: "Command" }) })
  const commandText = section.filter({ has: app.page.locator(currentMarkSelector) }).locator("pre")
  await expect(commandText).toHaveText(command)
  await expect(commandText).toBeInViewport()
  await expect(currentMark(app.page)).toHaveCount(1)
  await expect(currentMark(app.page)).toBeInViewport()
})

Then("the current match is in the reply {string}", async ({ app }, text: string) => {
  await expect(
    transcript(app.page)
      .locator("p")
      .filter({ has: app.page.locator(currentMarkSelector) }),
  ).toHaveText(text)
  await expect(currentMark(app.page)).toHaveCount(1)
  await expect(currentMark(app.page)).toBeInViewport()
})

Then("the current match is in the command row {string}", async ({ app }, label: string) => {
  const row = transcript(app.page).getByRole("button", { name: label, exact: true })
  await expect(row.locator(currentMarkSelector)).toHaveText(new RegExp(label, "i"))
  await expect(currentMark(app.page)).toHaveCount(1)
  await expect(currentMark(app.page)).toBeInViewport()
})

Then("nothing in the thread is marked", async ({ app }) => {
  await expect(transcript(app.page).locator("mark[data-find-match]")).toHaveCount(0)
})

When("I toggle the command group {string}", async ({ app }, label: string) => {
  await transcript(app.page).getByRole("button", { name: label }).click()
})

Then("the command row {string} is hidden", async ({ app }, label: string) => {
  await expect(transcript(app.page).getByRole("button", { name: label, exact: true })).toBeHidden()
})

Then("the command row {string} is shown", async ({ app }, label: string) => {
  await expect(transcript(app.page).getByRole("button", { name: label, exact: true })).toBeVisible()
})
