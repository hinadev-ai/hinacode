import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

/** Commands as the keybindings page names them. */
const COMMAND_IDS: Record<string, string> = {
  "Show or hide sidebar": "sidebar.toggle",
  "New thread": "thread.new",
}

const commandId = (title: string) => {
  const id = COMMAND_IDS[title]
  if (!id) throw new Error(`unknown command "${title}"; add it to COMMAND_IDS`)
  return id
}

const shortcutRow = (page: import("@playwright/test").Page, command: string) =>
  page.getByRole("row").filter({ has: page.getByRole("cell", { name: command, exact: true }) })

/** The form around a write-only secret field, which has its own Save and Clear buttons. */
const secretForm = (page: import("@playwright/test").Page, label: string) =>
  page.getByRole("textbox", { name: label, exact: true }).locator("xpath=ancestor::form")

Given("the saved language is {string}", ({ seed }, locale: string) => {
  seed.setting("locale", locale)
})

Given("the shortcut for {string} is saved as {string}", ({ seed }, command: string, chord: string) => {
  seed.setting("keybindings", { [commandId(command)]: chord })
})

When("I open settings", async ({ app }) => {
  await app.page.getByRole("link", { name: "Settings", exact: true }).click()
  await expect(app.page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible()
})

When("I open the settings section {string}", async ({ app }, section: string) => {
  await app.page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section }).click()
})

When("I choose the language {string}", async ({ app }, language: string) => {
  await app.page.getByLabel("Language", { exact: true }).click()
  await app.page.getByRole("option", { name: language, exact: true }).click()
})

When("I choose the default model {string} for {string}", async ({ app }, model: string, agent: string) => {
  const picker = app.page.getByLabel(agent, { exact: true })
  await expect(picker).toBeEnabled({ timeout: 30_000 })
  await picker.click()
  await app.page.getByRole("option", { name: model, exact: true }).click()
})

When("I record the shortcut {string} for {string}", async ({ app }, keys: string, command: string) => {
  const page = app.page
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Keybindings" }).click()
  await page.getByRole("button", { name: `Record a shortcut for ${command}`, exact: true }).click()
  await page.keyboard.press(keys)
})

When("I start recording a shortcut for {string}", async ({ app }, command: string) => {
  await app.page.getByRole("button", { name: `Record a shortcut for ${command}`, exact: true }).click()
})

When("I reset the shortcut for {string}", async ({ app }, command: string) => {
  await app.page.getByRole("button", { name: `Reset ${command} to its default shortcut`, exact: true }).click()
})

When("I save the Linear API key {string}", async ({ app }, key: string) => {
  await app.page.getByRole("textbox", { name: "Linear API key", exact: true }).fill(key)
  await secretForm(app.page, "Linear API key").getByRole("button", { name: "Save", exact: true }).click()
})

When("I clear the Linear API key", async ({ app }) => {
  await secretForm(app.page, "Linear API key").getByRole("button", { name: "Clear", exact: true }).click()
})

Then("the settings heading reads {string}", async ({ app }, heading: string) => {
  await expect(app.page.getByRole("heading", { level: 1, name: heading })).toBeVisible()
})

Then("the language {string} is saved", async ({ app }, locale: string) => {
  await expect.poll(async () => (await rpc(app.page, "settings.get", undefined)).locale).toBe(locale)
})

Then("the shortcut {string} is stored for {string}", async ({ app }, chord: string, command: string) => {
  await expect
    .poll(async () => (await rpc(app.page, "settings.get", undefined)).keybindings[commandId(command)])
    .toBe(chord)
})

Then("no shortcut override is stored for {string}", async ({ app }, command: string) => {
  await expect
    .poll(async () => (await rpc(app.page, "settings.get", undefined)).keybindings[commandId(command)])
    .toBeUndefined()
})

Then("the shortcut row for {string} reads {string}", async ({ app }, command: string, text: string) => {
  await expect(shortcutRow(app.page, command)).toContainText(text)
})

Then("the shortcut row for {string} does not read {string}", async ({ app }, command: string, text: string) => {
  await expect(shortcutRow(app.page, command)).not.toContainText(text)
})

Then(
  "the new thread composer for {string} preselects the model {string}",
  async ({ app, names }, project: string, model: string) => {
    await app.page.getByRole("button", { name: `New thread in ${names.of(project)}`, exact: true }).click()
    await expect(app.page.getByLabel("Model", { exact: true })).toHaveText(model, { timeout: 30_000 })
  },
)

// The status line sits right above the field's form; the Slack field has an identical one.
Then("the Linear API key status reads {string}", async ({ app }, text: string) => {
  await expect(secretForm(app.page, "Linear API key").locator("xpath=preceding-sibling::p[1]")).toHaveText(text)
})

Then("the secret {string} is stored", async ({ app }, name: string) => {
  expect(await rpc(app.page, "secrets.has", { name })).toBe(true)
})

Then("the secret {string} is not stored", async ({ app }, name: string) => {
  expect(await rpc(app.page, "secrets.has", { name })).toBe(false)
})
