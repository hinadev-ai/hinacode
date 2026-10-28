import { expect, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type { Message, MessagePart } from "../../src/shared/domain.ts"
import type { HinacodeApp } from "../support/app.ts"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const responses = new WeakMap<HinacodeApp, Message>()
const finishedAnswer = "The finished answer stays visible."
const progress = "Checking the repository."
const responseArticle = (page: Page) => page.locator("article[aria-busy]")
const workRow = (page: Page) => responseArticle(page).locator('[data-slot="worked-for"]')

Given("worked-for uses the {string} appearance", async ({ app }, appearance: string) => {
  if (appearance !== "light" && appearance !== "dark") throw new Error(`Unknown appearance ${appearance}`)
  const settings = await rpc(app.page, "clientSettings.get", undefined)
  await rpc(app.page, "clientSettings.set", {
    appearance: { ...settings.appearance, theme: appearance === "light" ? "light" : "default" },
  })
})

Given(
  "the thread {string} has a {word} response that took {int} seconds",
  async ({ app, threadIds }, title: string, state: string, seconds: number) => {
    if (state !== "finished" && state !== "running" && state !== "text-only") {
      throw new Error(`Unknown response state ${state}`)
    }
    const threadId = threadIds.get(title)
    if (!threadId) throw new Error(`Thread ${title} was not seeded`)
    const createdAt = "2026-10-12T00:00:00.000Z"
    const completedAt = new Date(Date.parse(createdAt) + seconds * 1000).toISOString()
    const work: ReadonlyArray<MessagePart> = [
      { type: "text", text: progress },
      { type: "reasoning", text: "Inspect the working directory first." },
      {
        type: "tool_call",
        callId: "timed-command",
        name: "Bash",
        input: { command: "pwd" },
        output: "/tmp/worked",
        status: "done",
      },
    ]
    const response: Message = {
      id: randomUUID(),
      threadId,
      role: "assistant",
      parts: [...(state === "text-only" ? [] : work), { type: "text", text: finishedAnswer }],
      createdAt,
      completedAt: state === "running" ? null : completedAt,
      usage: null,
      forkPoint: null,
    }
    responses.set(app, response)
    const db = new DatabaseSync(app.dbPath)
    try {
      db.prepare(
        "INSERT INTO message(id, thread_id, role, parts, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        response.id,
        response.threadId,
        response.role,
        JSON.stringify(response.parts),
        response.createdAt,
        response.completedAt,
      )
      if (state === "running") db.prepare("UPDATE thread SET status = 'running' WHERE id = ?").run(threadId)
    } finally {
      db.close()
    }
    await app.reload()
  },
)

Then("the worked-for row shows {string} without a collapse control", async ({ app }, duration: string) => {
  await expect(workRow(app.page)).toHaveText(`Worked for ${duration}`)
  await expect(workRow(app.page)).toBeVisible()
  await expect(responseArticle(app.page).getByRole("button", { name: /^Worked for / })).toHaveCount(0)
  await expect(workRow(app.page).locator("svg")).toHaveCount(0)
})

Then("the worked-for row shows {string} with its activity hidden", async ({ app }, duration: string) => {
  const toggle = responseArticle(app.page).getByRole("button", { name: `Worked for ${duration}`, exact: true })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(responseArticle(app.page).getByRole("button", { name: /pwd/ })).toHaveCount(0)
})

When("I toggle the worked-for row with {string}", async ({ app }, key: string) => {
  await workRow(app.page).focus()
  await app.page.keyboard.press(key)
})

Then("the response progress is visible", async ({ app }) => {
  await expect(responseArticle(app.page).getByText(progress, { exact: true })).toBeVisible()
})

Then("the timed command contains the current find match", async ({ app }) => {
  await expect(responseArticle(app.page).locator("mark[data-current]")).toHaveText("pwd")
})

Then("the finished answer stays visible", async ({ app }) => {
  await expect(responseArticle(app.page).getByText(finishedAnswer, { exact: true })).toBeVisible()
})

Then("the response progress and tool are visible", async ({ app }) => {
  await expect(responseArticle(app.page).getByText(progress, { exact: true })).toBeVisible()
  await expect(responseArticle(app.page).getByRole("button", { name: /pwd/ })).toBeVisible()
})

When("I inspect the timed command", async ({ app }) => {
  await responseArticle(app.page).getByRole("button", { name: /pwd/ }).click()
})

Then("the timed command output is visible", async ({ app }) => {
  await expect(responseArticle(app.page).getByText("/tmp/worked", { exact: true })).toBeVisible()
})

When("I find {string} in the timed response", async ({ app }, query: string) => {
  await app.page.keyboard.press("ControlOrMeta+f")
  await app.page.getByRole("textbox", { name: "Find in thread", exact: true }).fill(query)
})

Then("the response has no worked-for row", async ({ app }) => {
  await expect(responseArticle(app.page).getByText(/^Worked for /)).toHaveCount(0)
})

When("the timed response completes", async ({ app }) => {
  const response = responses.get(app)
  if (!response) throw new Error("No timed response was seeded")
  const completed: Message = { ...response, completedAt: "2026-10-12T00:08:05.000Z" }
  const { seq } = await rpc(app.page, "threads.transcript", { threadId: response.threadId })
  await app.pushEvents([{ type: "message.updated", message: completed, seq: seq + 1 }])
})
