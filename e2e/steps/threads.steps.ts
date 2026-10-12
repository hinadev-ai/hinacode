import { expect } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"

When("I create a thread titled {string} in {string}", async ({ app, names }, title: string, project: string) => {
  const page = app.page
  await page.getByRole("button", { name: `New thread in ${names.of(project)}`, exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Title", { exact: true }).fill(names.of(title))
  // The model picker is disabled until the agent lists its models; click() waits for it to be enabled.
  await expect(dialog.getByLabel("Model", { exact: true })).toBeEnabled({ timeout: 30_000 })
  await dialog.getByRole("button", { name: "Create thread", exact: true }).click()
  await expect(dialog).toBeHidden()
})

When("I open the thread {string} from the sidebar", async ({ app, names }, title: string) => {
  await app.page
    .getByRole("navigation", { name: "Projects and threads" })
    .getByRole("link", { name: names.of(title) })
    .click()
})

Then("the thread {string} is open", async ({ app, names }, title: string) => {
  await expect(app.page.getByRole("heading", { level: 1, name: names.of(title) })).toBeVisible()
})

Then("the sidebar lists the thread {string}", async ({ app, names }, title: string) => {
  await expect(
    app.page.getByRole("navigation", { name: "Projects and threads" }).getByRole("link", { name: names.of(title) }),
  ).toBeVisible()
})
