import { expect } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"

When("I start a new thread in {string}", async ({ app, names }, project: string) => {
  await app.page.getByRole("button", { name: `New thread in ${names.of(project)}`, exact: true }).click()
})

/** A thread starts with a placeholder title until its first message names it. */
const placeholderTitle = /^thread-[0-9a-f]{5}$/

Then("a new thread is open with the composer focused", async ({ app }) => {
  await expect(app.page.getByRole("heading", { level: 1, name: placeholderTitle })).toBeVisible()
  await expect(app.page.getByRole("combobox", { name: "Message", exact: true })).toBeFocused()
})

Then("the sidebar lists the open thread", async ({ app }) => {
  const title = await app.page.getByRole("heading", { level: 1, name: placeholderTitle }).textContent()
  await expect(
    app.page.getByRole("navigation", { name: "Projects and threads" }).getByRole("link", { name: title ?? "" }),
  ).toBeVisible()
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
