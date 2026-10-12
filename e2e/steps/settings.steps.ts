import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

/** Commands as the keybindings page names them. */
const COMMAND_IDS: Record<string, string> = {
  "Show or hide sidebar": "sidebar.toggle",
}

const commandId = (title: string) => {
  const id = COMMAND_IDS[title]
  if (!id) throw new Error(`unknown command "${title}"; add it to COMMAND_IDS`)
  return id
}

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

When("I choose the language {string}", async ({ app }, language: string) => {
  await app.page.getByLabel("Language", { exact: true }).click()
  await app.page.getByRole("option", { name: language, exact: true }).click()
})

When("I record the shortcut {string} for {string}", async ({ app }, keys: string, command: string) => {
  const page = app.page
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Keybindings" }).click()
  await page.getByRole("button", { name: `Record a shortcut for ${command}`, exact: true }).click()
  await page.keyboard.press(keys)
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
