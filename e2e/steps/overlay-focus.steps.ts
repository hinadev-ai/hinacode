import { expect } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"

When("I open and close the machine resources popover", async ({ app }) => {
  await app.page.getByRole("button", { name: "Machine resources" }).click()
  await expect(app.page.getByRole("dialog")).toBeVisible()
  await app.page.keyboard.press("Escape")
  await expect(app.page.getByRole("dialog")).toBeHidden()
})

When("I click the message box", async ({ app }) => {
  await app.page.getByLabel("Message", { exact: true }).click()
})

When("nothing has focus", async ({ app }) => {
  await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(app.page.locator("body")).toBeFocused()
})

Then("the message box is focused", async ({ app }) => {
  await expect(app.page.getByLabel("Message", { exact: true })).toBeFocused()
})
