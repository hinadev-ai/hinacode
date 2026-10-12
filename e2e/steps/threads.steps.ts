import { expect } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"
import { sidebar, threadMenu } from "../support/ui.ts"

When("I create a thread titled {string} in {string}", async ({ app, names }, title: string, project: string) => {
  const page = app.page
  await page.getByRole("button", { name: `New thread in ${names.of(project)}`, exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Title", { exact: true }).fill(names.of(title))
  // The model picker is disabled until the agent lists its models.
  await expect(dialog.getByLabel("Model", { exact: true })).toBeEnabled({ timeout: 30_000 })
  await dialog.getByRole("button", { name: "Create thread", exact: true }).click()
  await expect(dialog).toBeHidden()
})

When("I open the thread {string} from the sidebar", async ({ app, names }, title: string) => {
  await sidebar(app.page)
    .getByRole("link", { name: names.of(title) })
    .click()
})

When("I collapse the threads of {string}", async ({ app, names }, project: string) => {
  await sidebar(app.page)
    .getByRole("button", { name: `Show or hide threads in ${names.of(project)}`, exact: true })
    .click()
})

When("I expand the threads of {string}", async ({ app, names }, project: string) => {
  await sidebar(app.page)
    .getByRole("button", { name: `Show or hide threads in ${names.of(project)}`, exact: true })
    .click()
})

// dnd-kit's keyboard sensor: Space picks the row up, the arrows move it, Space drops it.
When("I move the thread {string} up with the keyboard", async ({ app, names }, title: string) => {
  await sidebar(app.page)
    .getByRole("button", { name: `Reorder ${names.of(title)}`, exact: true })
    .focus()
  await app.page.keyboard.press("Space")
  await app.page.keyboard.press("ArrowUp")
  await app.page.keyboard.press("Space")
})

When("I rename the thread {string} to {string}", async ({ app, names }, title: string, next: string) => {
  await threadMenu(app.page, names.of(title), "Rename")
  const input = app.page.getByRole("textbox", { name: `New name for ${names.of(title)}`, exact: true })
  await input.fill(names.of(next))
  await input.press("Enter")
})

When("I settle the thread {string} from its menu", async ({ app, names }, title: string) => {
  await threadMenu(app.page, names.of(title), "Settle…")
  const dialog = app.page.getByRole("alertdialog")
  await expect(dialog).toContainText("Settle this thread?")
  await dialog.getByRole("button", { name: "Settle", exact: true }).click()
  await expect(dialog).toBeHidden()
})

When("I delete the thread {string} from its menu", async ({ app, names }, title: string) => {
  await threadMenu(app.page, names.of(title), "Delete…")
  const dialog = app.page.getByRole("alertdialog")
  await expect(dialog).toContainText(`"${names.of(title)}"`)
  await dialog.getByRole("button", { name: "Delete thread", exact: true }).click()
  await expect(dialog).toBeHidden()
})

Then("the thread {string} is open", async ({ app, names }, title: string) => {
  await expect(app.page.getByRole("heading", { level: 1, name: names.of(title) })).toBeVisible()
})

Then("the sidebar lists the thread {string}", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toBeVisible()
})

Then("the sidebar does not list the thread {string}", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toBeHidden()
})

Then("the sidebar lists the threads {string} in that order", async ({ app, names }, titles: string) => {
  const expected = titles.split(",").map((title) => names.of(title.trim()))
  // The drop animation moves rows for a moment after the keyboard drop; poll until the order settles.
  await expect
    .poll(async () => {
      const links = await sidebar(app.page).getByRole("link").allTextContents()
      return links.map((text) => expected.find((title) => text.includes(title))).filter(Boolean)
    })
    .toStrictEqual(expected)
})

Then("the thread {string} is marked settled", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toContainText("Settled")
  const threads = await rpc(app.page, "threads.list", undefined)
  expect(threads.find((thread) => thread.title === names.of(title))?.status).toBe("settled")
})

Then("the thread {string} no longer exists", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toBeHidden()
  const threads = await rpc(app.page, "threads.list", undefined)
  expect(threads.some((thread) => thread.title === names.of(title))).toBe(false)
})
