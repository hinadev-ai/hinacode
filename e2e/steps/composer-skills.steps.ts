import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import type { HinacodeApp } from "../support/app.ts"
import { rpc } from "../support/rpc.ts"

const message = (app: HinacodeApp) => app.page.getByRole("combobox", { name: "Message", exact: true })

Given("an isolated thread with a simulated agent that has a skill", async ({ todoApp: app, repo }) => {
  const project = await rpc(app.page, "projects.create", { name: "Skills", rootPath: repo, setupScript: null })
  const thread = await rpc(app.page, "threads.create", { projectId: project.id })
  await rpc(app.page, "threads.update", {
    id: thread.id,
    provider: "claude",
    model: "claude-sonnet-5-5",
    title: "Skill chips",
  })
  await app.reload()
  await app.page
    .getByRole("navigation", { name: "Projects and threads" })
    .getByRole("link")
    .filter({ hasText: "Skill chips" })
    .click()
})

When("I type {string} in the message", async ({ todoApp: app }, text: string) => {
  await message(app).pressSequentially(text)
})

When("I pick {string} from the commands", async ({ todoApp: app }, insert: string) => {
  await app.page
    .getByRole("listbox", { name: "Commands", exact: true })
    .getByRole("option")
    .filter({ hasText: insert })
    .click()
})

Then("the message starts with the skill chip {string}", async ({ todoApp: app }, name: string) => {
  await expect(message(app)).toHaveAccessibleDescription(`Skill: ${name}`)
  await expect(app.page.getByText(name, { exact: true })).toBeVisible()
  await expect(message(app)).not.toHaveValue(new RegExp(name))
})

When("I send the message with its skill", async ({ todoApp: app }) => {
  await app.page.getByRole("button", { name: "Send", exact: true }).click()
})

Then("my message {string} is in the thread", async ({ todoApp: app }, text: string) => {
  await expect(app.page.getByRole("article", { name: "You", exact: true })).toContainText(text)
})

When("I press Backspace at the start of the message", async ({ todoApp: app }) => {
  await message(app).evaluate((textarea: HTMLTextAreaElement) => textarea.setSelectionRange(0, 0))
  await message(app).press("Backspace")
})

Then("the message has no skill chip and reads {string}", async ({ todoApp: app }, text: string) => {
  await expect(message(app)).toHaveValue(text)
  await expect(message(app)).toHaveAccessibleDescription("")
})
