import { expect, type Locator, type Page } from "@playwright/test"
import { type Names, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"
import { clickRowButton, composerText, sidebar, threadMenu } from "../support/ui.ts"

When("I start a new thread in {string}", async ({ app, names }, project: string) => {
  await app.page.getByRole("button", { name: `New thread in ${names.of(project)}`, exact: true }).click()
})

const composer = (page: Page) => page.getByRole("combobox", { name: "Message", exact: true })

const openThread = async (page: Page) => {
  const location = await page.evaluate(() => localStorage.getItem("hinacode.location"))
  const id = location?.match(/^\/thread\/([^/?]+)/)?.[1]
  const threads = await rpc(page, "threads.list", undefined)
  return threads.find((thread) => thread.id === id)
}

Then("a new thread is open with the composer focused", async ({ app }) => {
  await expect(app.page.getByRole("heading", { level: 1, name: "New thread", exact: true })).toBeVisible()
  await expect(composer(app.page)).toBeFocused()
})

Then("the sidebar does not list the open draft", async ({ app }) => {
  const draft = await openThread(app.page)
  expect(draft?.status).toBe("draft")
  await expect(sidebar(app.page).getByRole("link", { name: draft?.title ?? "", exact: true })).toHaveCount(0)
})

When("I type {string} into the composer", async ({ app }, text: string) => {
  await composer(app.page).pressSequentially(text)
})

Then("the composer holds {string}", async ({ app }, text: string) => {
  await expect.poll(() => composerText(composer(app.page))).toBe(text)
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

When("I archive the thread {string} from its menu", async ({ app, names }, title: string) => {
  await threadMenu(app.page, names.of(title), "Archive")
})

When("I scroll the sidebar to the thread {string}", async ({ app, names }, title: string) => {
  await sidebar(app.page)
    .getByRole("link", { name: names.of(title) })
    .scrollIntoViewIfNeeded()
})

When("I archive the thread {string} from its row", async ({ app, names }, title: string) => {
  await clickRowButton(sidebar(app.page), `Archive ${names.of(title)}`)
})

Then("the thread {string} is in view in the sidebar", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toBeInViewport()
})

When("I open the sidebar tab {string}", async ({ app }, tab: string) => {
  await sidebar(app.page).getByRole("tab", { name: tab, exact: true }).click()
  await expect(openTab(app.page)).toHaveCount(1)
})

When("I scroll to the end of the sidebar", async ({ app }) => {
  await sidebar(app.page).getByRole("link").last().scrollIntoViewIfNeeded()
})

Then("the sidebar lists {int} thread(s)", async ({ app }, count: number) => {
  await expect(sidebar(app.page).getByRole("link")).toHaveCount(count)
})

When("I undo from the toast", async ({ app }) => {
  await app.page.getByRole("button", { name: "Undo", exact: true }).click()
})

When("I unarchive the thread {string}", async ({ app, names }, title: string) => {
  await clickRowButton(sidebar(app.page), `Unarchive ${names.of(title)}`)
})

const sidebarFilter = (page: Page) => sidebar(page).getByRole("searchbox", { name: "Filter threads and projects" })

When("I filter the sidebar by {string}", async ({ app }, query: string) => {
  await sidebarFilter(app.page).fill(query)
})

When("I filter the sidebar by the name of the project {string}", async ({ app, names }, project: string) => {
  await sidebarFilter(app.page).fill(names.of(project))
})

When("I show only the project {string} in the sidebar", async ({ app, names }, project: string) => {
  await sidebar(app.page).getByRole("button", { name: "Filter by project", exact: true }).click()
  await app.page.getByRole("menuitemcheckbox", { name: names.of(project), exact: true }).click()
  await app.page.keyboard.press("Escape")
})

When("I delete the thread {string} from its menu", async ({ app, names }, title: string) => {
  await threadMenu(app.page, names.of(title), "Delete…")
  const dialog = app.page.getByRole("dialog")
  await expect(dialog).toContainText(`"${names.of(title)}"`)
  await dialog.getByRole("button", { name: "Delete thread", exact: true }).click()
  await expect(dialog).toBeHidden()
})

Then("the thread {string} is open", async ({ app, names }, title: string) => {
  await expect(app.page.getByRole("heading", { level: 1 })).toHaveText([names.of(title)])
})

Then("the sidebar lists the thread {string}", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toBeVisible()
})

Then("the sidebar does not list the thread {string}", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toBeHidden()
})

Then("the sidebar lists the threads {string} in that order", async ({ app, names }, titles: string) => {
  const expected = titles.split(",").map((title) => names.of(title.trim()))
  await expect
    .poll(async () => {
      const links = await sidebar(app.page).getByRole("link").allTextContents()
      return links.map((text) => expected.find((title) => text.includes(title))).filter(Boolean)
    })
    .toStrictEqual(expected)
})

When("I pin the thread {string} from its menu", async ({ app, names }, title: string) => {
  await threadMenu(app.page, names.of(title), "Pin")
})

When("I unpin the thread {string} from its menu", async ({ app, names }, title: string) => {
  await threadMenu(app.page, names.of(title), "Unpin")
})

When("I copy the ID of the thread {string} from its menu", async ({ app, names }, title: string) => {
  await threadMenu(app.page, names.of(title), "Copy thread ID")
})

Then("the clipboard holds the ID of the thread {string}", async ({ app, threadIds }, title: string) => {
  await expect.poll(() => app.clipboardText()).toBe(threadIds.get(title))
})

const ownTitles = async (region: Locator, names: Names) =>
  (await region.getByRole("link").locator("[dir=auto]").allTextContents()).filter((text) => text.includes(names.of("")))

const pinned = (page: Page) => sidebar(page).getByRole("region", { name: "Pinned", exact: true })

Then("the pinned threads are {string}", async ({ app, names }, titles: string) => {
  const expected = titles.split(",").map((title) => names.of(title.trim()))
  await expect.poll(() => ownTitles(pinned(app.page), names)).toStrictEqual(expected)
})

Then("no thread is pinned", async ({ app, names }) => {
  await expect.poll(() => ownTitles(pinned(app.page), names)).toStrictEqual([])
})

const snoozed = (page: Page) => sidebar(page).getByRole("region", { name: "Snoozed", exact: true })

Then("the snoozed threads are {string}", async ({ app, names }, titles: string) => {
  const expected = titles.split(",").map((title) => names.of(title.trim()))
  await expect.poll(() => ownTitles(snoozed(app.page), names)).toStrictEqual(expected)
})

Then("no thread is snoozed", async ({ app, names }) => {
  await expect.poll(() => ownTitles(snoozed(app.page), names)).toStrictEqual([])
})

const openTab = (page: Page) => sidebar(page).getByRole("tabpanel")

Then("the open tab lists the threads {string} in that order", async ({ app, names }, titles: string) => {
  const expected = titles.split(",").map((title) => names.of(title.trim()))
  await expect
    .poll(async () => {
      const links = await openTab(app.page).getByRole("link").allTextContents()
      return links.map((text) => expected.find((title) => text.includes(title))).filter(Boolean)
    })
    .toStrictEqual(expected)
})

Then("the open tab lists the thread {string}", async ({ app, names }, title: string) => {
  await expect(openTab(app.page).getByRole("link", { name: names.of(title) })).toBeVisible()
})

const openTabMenu = async (page: Page, title: string, item: string) => {
  await clickRowButton(openTab(page), `Actions for ${title}`)
  await page.getByRole("menuitem", { name: item, exact: true }).click()
}

When(
  "I snooze the thread {string} until {string} from its menu",
  async ({ app, names }, title: string, time: string) => {
    await openTabMenu(app.page, names.of(title), "Snooze…")
    await app.page.getByRole("combobox", { name: "Snooze until" }).fill(time)
    await app.page.keyboard.press("Enter")
  },
)

When(
  "I click the menu button of the thread {string} with the pointer resting elsewhere",
  async ({ app, names }, title: string) => {
    await app.page.mouse.move(0, 0)
    await openTab(app.page)
      .getByRole("button", { name: `Actions for ${names.of(title)}`, exact: true })
      .click()
  },
)

Then("the thread menu offers {string}", async ({ app }, item: string) => {
  await expect(app.page.getByRole("menuitem", { name: item, exact: true })).toBeVisible()
})

const snoozePicker = (page: Page) => page.getByRole("dialog", { name: /^Snooze / })

When(
  "I type {string} into the snooze picker of the thread {string} and press Enter",
  async ({ app, names }, time: string, title: string) => {
    await openTabMenu(app.page, names.of(title), "Snooze…")
    await app.page.getByRole("combobox", { name: "Snooze until" }).fill(time)
    await expect(snoozePicker(app.page).getByRole("status")).not.toBeEmpty()
    await app.page.keyboard.press("Enter")
  },
)

Then("the snooze picker is still open and says {string}", async ({ app }, problem: string) => {
  await expect(snoozePicker(app.page)).toHaveAttribute("data-open")
  await expect(snoozePicker(app.page).getByRole("status")).toHaveText(problem)
})

When("I pick the next snooze preset with the keyboard", async ({ app }) => {
  await app.page.keyboard.press("ArrowDown")
  await app.page.keyboard.press("Enter")
})

When("I unsnooze the thread {string} from its menu", async ({ app, names }, title: string) => {
  await openTabMenu(app.page, names.of(title), "Unsnooze")
})

Then("the open tab does not list the thread {string}", async ({ app, names }, title: string) => {
  await expect(openTab(app.page).getByRole("link", { name: names.of(title) })).toBeHidden()
})

const openThreadProjectId = async (page: Page) => (await openThread(page))?.projectId

Then("the open thread belongs to the project {string}", async ({ app, projectIds }, project: string) => {
  expect(await openThreadProjectId(app.page)).toBe(projectIds.get(project))
})

Then("the open thread belongs to the first project", async ({ app }) => {
  const [first] = await rpc(app.page, "projects.list", undefined)
  expect(await openThreadProjectId(app.page)).toBe(first?.id)
})

Then("the thread {string} is stored as {string}", async ({ app, names }, title: string, status: string) => {
  await expect
    .poll(async () => {
      const threads = await rpc(app.page, "threads.list", undefined)
      return threads.find((thread) => thread.title === names.of(title))?.status
    })
    .toBe(status)
})

Then("the thread {string} no longer exists", async ({ app, names }, title: string) => {
  await expect(sidebar(app.page).getByRole("link", { name: names.of(title) })).toBeHidden()
  const threads = await rpc(app.page, "threads.list", undefined)
  expect(threads.some((thread) => thread.title === names.of(title))).toBe(false)
})

Then("the row of the thread {string} keeps its height when hovered", async ({ app, names }, title: string) => {
  const link = sidebar(app.page).getByRole("link", { name: names.of(title) })
  const row = link.locator("xpath=ancestor::li[1]")
  const heightOf = async () => (await row.boundingBox())?.height
  await app.page.mouse.move(0, 0)
  const resting = await heightOf()
  await row.hover()
  await expect.poll(heightOf).toBe(resting)
})
