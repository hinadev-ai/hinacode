import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import type { HinacodeApp } from "../support/app.ts"
import { rpc } from "../support/rpc.ts"
import { sidebar } from "../support/ui.ts"

const tray = (app: HinacodeApp) => app.page.getByRole("region", { name: "Agent activity", exact: true })
const backgroundTasks = (app: HinacodeApp) => tray(app).getByRole("list", { name: "Background tasks", exact: true })

Given("an isolated thread with a simulated agent that starts background shells", async ({ activityApp: app, repo }) => {
  const project = await rpc(app.page, "projects.create", { name: "Activity", rootPath: repo, setupScript: null })
  const thread = await rpc(app.page, "threads.create", { projectId: project.id })
  await rpc(app.page, "threads.update", {
    id: thread.id,
    provider: "claude",
    model: "claude-sonnet-5-5",
    title: "Shells",
  })
  await app.reload()
  await app.page
    .getByRole("navigation", { name: "Projects and threads" })
    .getByRole("link")
    .filter({ hasText: "Shells" })
    .click()
})

When("I send a message to the activity thread", async ({ activityApp: app }) => {
  await app.page.getByLabel("Message", { exact: true }).fill("Start the dev server and the tests")
  await app.page.getByRole("button", { name: "Send", exact: true }).click()
})

Then(
  "the activity tray shows the plan, the sub-agent and the shells {string} and {string}",
  async ({ activityApp: app }, first: string, second: string) => {
    await expect(tray(app).getByRole("button", { name: "Agent tasks", exact: true })).toContainText("1 of 3 done")
    await expect(tray(app)).toContainText("Audit the composer")
    await expect(backgroundTasks(app).getByRole("listitem")).toHaveText([new RegExp(first), new RegExp(second)])
  },
)

When("I stop the background task {string}", async ({ activityApp: app }, label: string) => {
  await backgroundTasks(app)
    .getByRole("button", { name: `Stop ${label}`, exact: true })
    .click()
})

Then("only the background task {string} is left", async ({ activityApp: app }, label: string) => {
  await expect(backgroundTasks(app).getByRole("listitem")).toHaveText([new RegExp(label)])
})

When("I stop the turn", async ({ activityApp: app }) => {
  await app.page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(app.page.getByRole("button", { name: "Send", exact: true })).toBeVisible()
})

Then("the background task {string} is still running", async ({ activityApp: app }, label: string) => {
  await expect(tray(app)).not.toContainText("Audit the composer")
  await expect(backgroundTasks(app).getByRole("button", { name: `Stop ${label}`, exact: true })).toBeVisible()
})

Then("the sidebar shows the thread working in the background", async ({ activityApp: app }) => {
  await expect(sidebar(app.page).getByRole("link", { name: "Shells" })).toContainText("Working in the background")
})

When("I type {string} in the activity thread's message", async ({ activityApp: app }, text: string) => {
  await app.page.getByRole("combobox", { name: "Message", exact: true }).pressSequentially(text)
})

Then("the commands list covers the activity tray", async ({ activityApp: app }) => {
  const list = app.page.getByRole("listbox", { name: "Commands", exact: true })
  const box = await list.boundingBox()
  if (box === null) throw new Error("The commands list is not shown")
  // The list's bottom edge sits over the tray, so a tray painted above the list hides it there.
  const point = { x: box.x + box.width / 2, y: box.y + box.height - 4 }
  const topmost = await app.page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=listbox]") !== null,
    point,
  )
  expect(topmost).toBe(true)
})
