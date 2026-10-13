import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import type { KkcodeApp } from "../support/app.ts"
import { rpc } from "../support/rpc.ts"

const openOnlyThread = async (app: KkcodeApp) => {
  const threads = await rpc(app.page, "threads.list", undefined)
  expect(threads).toHaveLength(1)
  const thread = threads[0]
  if (!thread) throw new Error("Task thread is missing")
  await app.page
    .getByRole("navigation", { name: "Projects and threads" })
    .getByRole("link")
    .filter({ hasText: thread.title })
    .click()
}

const sendMessage = async (app: KkcodeApp, message: string) => {
  await app.page.getByLabel("Message", { exact: true }).fill(message)
  await app.page.getByRole("button", { name: "Send", exact: true }).click()
}

const taskBar = (app: KkcodeApp) => app.page.getByRole("button", { name: "Agent tasks", exact: true })

Given("an isolated thread with a simulated agent that plans tasks", async ({ todoApp: app, repo }) => {
  const project = await rpc(app.page, "projects.create", { name: "Tasks", rootPath: repo, setupScript: null })
  const thread = await rpc(app.page, "threads.create", { projectId: project.id })
  await rpc(app.page, "threads.update", {
    id: thread.id,
    provider: "claude",
    model: "claude-sonnet-5-5",
    title: "Task list",
  })
  await app.reload()
  await openOnlyThread(app)
})

When("I send a message to the task thread", async ({ todoApp: app }) => {
  await sendMessage(app, "Plan the work, then do it")
})

Then("the composer shows 1 of 3 tasks done and {string} in progress", async ({ todoApp: app }, current: string) => {
  await expect(taskBar(app)).toContainText("1 of 3 done")
  await expect(taskBar(app)).toContainText(current)
  await expect(app.page.getByText("One task done, two to go.")).toBeVisible()
})

When("I expand the task list above the composer", async ({ todoApp: app }) => {
  await taskBar(app).click()
  await expect(taskBar(app)).toHaveAttribute("aria-expanded", "true")
})

Then(
  "the expanded list shows {string}, {string} and {string}",
  async ({ todoApp: app }, first: string, second: string, third: string) => {
    const list = app.page.getByRole("list", { name: "Agent tasks", exact: true })
    await expect(list).toContainText(first)
    await expect(list).toContainText(second)
    await expect(list).toContainText(third)
  },
)

When("I send a follow-up message to the task thread", async ({ todoApp: app }) => {
  await sendMessage(app, "Finish the rest")
})

Then("the task list above the composer is gone", async ({ todoApp: app }) => {
  await expect(app.page.getByText("All tasks are done.")).toBeVisible()
  await expect(taskBar(app)).toBeHidden()
})
