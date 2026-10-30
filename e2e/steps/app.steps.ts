import { expect } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"

When("the app restarts", async ({ app }) => {
  await app.restart()
})

When("I press {string}", async ({ app }, keys: string) => {
  await app.page.keyboard.press(keys)
})

Then("the sidebar is hidden", async ({ app }) => {
  await expect(app.page.getByRole("button", { name: "Show sidebar" })).toBeVisible()
  await expect(app.page.getByRole("navigation", { name: "Projects and threads" })).toBeHidden()
})

Then("the sidebar is shown", async ({ app }) => {
  await expect(app.page.getByRole("navigation", { name: "Projects and threads" })).toBeVisible()
})

Then("the sidebar is labelled {string}", async ({ app }, label: string) => {
  await expect(app.page.getByRole("navigation", { name: label })).toBeVisible()
})

Then("pressing {string} leaves the sidebar hidden", async ({ app }, keys: string) => {
  await app.page.keyboard.press(keys)
  await expect(app.page.getByRole("navigation", { name: "Projects and threads" })).toBeHidden()
})
