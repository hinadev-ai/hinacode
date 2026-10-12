import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const existingAppearance = { theme: "catppuccin-latte", fontSize: 18, uiFont: "sans-serif", monoFont: "monospace" }

Given("an existing named theme and font preference", ({ seed }) => {
  seed.setting("appearance", existingAppearance)
})

When("I open appearance settings", async ({ app }) => {
  await app.page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Appearance" })
    .click()
})

When("I choose the theme {string}", async ({ app }, theme: string) => {
  await app.page.getByRole("radio", { name: theme, exact: true }).check()
})

When("the system appearance changes to {string}", async ({ app }, scheme: string) => {
  if (scheme !== "dark" && scheme !== "light") throw new Error(`Unknown appearance ${scheme}`)
  await app.page.emulateMedia({ colorScheme: scheme })
})

Then("the app uses the {string} appearance", async ({ app }, scheme: string) => {
  await expect
    .poll(() => app.page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light")))
    .toBe(scheme)
})

Then("the theme {string} is saved", async ({ app }, theme: string) => {
  await expect.poll(async () => (await rpc(app.page, "settings.get", undefined)).appearance.theme).toBe(theme)
})

Then("the existing named theme and font preference is preserved", async ({ app }) => {
  expect((await rpc(app.page, "settings.get", undefined)).appearance).toEqual(existingAppearance)
  await expect(app.page.locator("html")).toHaveAttribute("data-theme", "catppuccin-latte")
  await expect(app.page.locator("html")).toHaveCSS("font-size", "18px")
})
