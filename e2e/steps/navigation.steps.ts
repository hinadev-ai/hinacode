import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"

Given("the window is too narrow to dock the sidebar", async ({ app }) => {
  await app.setWindow({ width: 720, height: 820, zoom: 1 })
  await app.page.setViewportSize({ width: 720, height: 820 })
  await expect(app.page.getByRole("button", { name: "Show sidebar", exact: true })).toBeVisible()
})

When("I open the sidebar overlay", async ({ app }) => {
  await app.page.getByRole("button", { name: "Show sidebar", exact: true }).click()
  await expect(app.page.getByRole("dialog", { name: "Projects and threads" })).toBeVisible()
})

When("focus leaves the sidebar overlay", async ({ app }) => {
  await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
})

Then("the sidebar overlay is closed", async ({ app }) => {
  await expect(app.page.getByRole("dialog", { name: "Projects and threads" })).toBeHidden()
})
