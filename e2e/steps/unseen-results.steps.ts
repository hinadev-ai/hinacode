import { expect, type Page } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"
import { sidebar } from "../support/ui.ts"

const row = (page: Page, title: string) => sidebar(page).getByRole("link", { name: title })

When("the window regains focus", async ({ app }) => {
  await app.page.evaluate(() => {
    document.hasFocus = () => true
    window.dispatchEvent(new FocusEvent("focus"))
  })
})

Then("the sidebar marks {string} as {string}", async ({ app, names }, title: string, mark: string) => {
  await expect(row(app.page, names.of(title))).toContainText(mark)
})

Then("the sidebar does not mark {string}", async ({ app, names }, title: string) => {
  await expect(row(app.page, names.of(title))).not.toContainText("not yet opened")
})
