import { expect, type Locator, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import type { DataTable } from "playwright-bdd"
import type { AgentEvent } from "../../src/shared/agent.ts"
import type { PushEvent } from "../../src/shared/contract.ts"
import type { Message } from "../../src/shared/domain.ts"
import type { KkcodeApp } from "../support/app.ts"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const transcript = (page: Page) => page.locator("article[aria-busy]")
const findField = (page: Page) => page.getByRole("textbox", { name: "Find in thread", exact: true })
const currentMarkSelector = "mark[data-find-match][data-current]"
const currentMark = (page: Page) => transcript(page).locator(currentMarkSelector)

interface TurnRow {
  readonly kind?: string
  readonly text?: string
  readonly description?: string
}

const finishTurn = async (
  app: KkcodeApp,
  threadIds: Map<string, string>,
  title: string,
  rows: ReadonlyArray<TurnRow>,
) => {
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
  for (const [row, { kind, text = "", description = "" }] of rows.entries()) {
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
}

Given("the agent finished a turn in {string} with", async ({ app, threadIds }, title: string, table: DataTable) => {
  await finishTurn(app, threadIds, title, table.hashes())
})

Given(
  "the agent finished a turn in {string} running a command that prints {int} {string} then {string}",
  async ({ app, threadIds }, title: string, count: number, filler: string, tail: string) => {
    await finishTurn(app, threadIds, title, [
      { kind: "command", text: `printf ${filler.repeat(count)}${tail}` },
      { kind: "command", text: "pwd" },
    ])
  },
)

Given(
  "the agent finished a turn in {string} running {string} described by {int} {string} then {string}",
  async ({ app, threadIds }, title: string, command: string, count: number, filler: string, tail: string) => {
    await finishTurn(app, threadIds, title, [
      { kind: "command", text: command, description: `${filler.repeat(count)}${tail}` },
      { kind: "command", text: "pwd" },
    ])
  },
)

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

When("I toggle the command row {string}", async ({ app }, label: string) => {
  await transcript(app.page).getByRole("button", { name: label, exact: true }).click()
})

Then("the command {string} is hidden", async ({ app }, command: string) => {
  await expect(transcript(app.page).locator("section pre").filter({ hasText: command })).toBeHidden()
})

Then("the current match is in an open command ending in {string}", async ({ app }, tail: string) => {
  const row = transcript(app.page)
    .locator("li")
    .filter({ has: app.page.locator(currentMarkSelector) })
  await expect(row.getByRole("button", { expanded: true })).toHaveCount(1)
  const commandText = row
    .locator("section")
    .filter({ has: app.page.getByRole("heading", { name: "Command" }) })
    .locator("pre")
  await expect(commandText).toHaveText(new RegExp(`^printf x+${tail}$`))
  await expect(commandText.locator(currentMarkSelector)).toHaveText(tail)
  await expect(currentMark(app.page)).toHaveCount(1)
  await expect(currentMark(app.page)).toBeInViewport()
})

const isClipped = (label: Locator) => label.evaluate((element) => element.scrollWidth > element.clientWidth)

Then("the current match is in a command row that shows its whole label", async ({ app }) => {
  const label = transcript(app.page)
    .locator("li span[title]")
    .filter({ has: app.page.locator(currentMarkSelector) })
  await expect(label).toHaveCount(1)
  await expect.poll(() => isClipped(label)).toBe(false)
  await expect(currentMark(app.page)).toHaveCount(1)
  await expect(currentMark(app.page)).toBeInViewport()
})

Then("the command row {string} truncates its label again", async ({ app }, command: string) => {
  const label = transcript(app.page).locator(`li span[title="${command}"]`)
  await expect.poll(() => isClipped(label)).toBe(true)
})
