import { expect } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"

When("I open the models settings with the simulated Claude Code account", async ({ usageLimitApp: app }) => {
  await app.page.getByRole("link", { name: "Settings", exact: true }).click()
  await app.page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Models" }).click()
})

Then(
  "the models settings show {string} on {string} for {string}",
  async ({ usageLimitApp: app }, signedIn: string, plan: string, organization: string) => {
    const account = app.page.getByRole("status", { name: "Claude Code account" })
    await expect(account).toContainText(signedIn)
    await expect(account).toContainText(plan)
    await expect(account).toContainText(organization)
  },
)
