import { expect } from "@playwright/test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Given, Then, When } from "../support/fixtures.ts"

const fileTree = (page: import("@playwright/test").Page) => page.getByRole("tree", { name: "Workspace files" })

Given("I append {string} to {string} in my repository", ({ repo }, text: string, file: string) => {
  appendFileSync(join(repo, file), `${text}\n`)
})

Then("the file tree has focus", async ({ app }) => {
  await expect(fileTree(app.page)).toBeFocused()
})

Then(
  "the file tree marks {string} as modified and {string} as ignored",
  async ({ app }, modified: string, ignored: string) => {
    const tree = fileTree(app.page)
    await expect(tree.getByRole("treeitem", { name: modified, exact: true })).toHaveAccessibleDescription("Modified")
    await expect(tree.getByRole("treeitem", { name: ignored, exact: true })).toHaveAccessibleDescription("Ignored")
  },
)

When("I type {string} in the file tree and press Enter", async ({ app }, text: string) => {
  await app.page.keyboard.type(text)
  await app.page.keyboard.press("Enter")
})

When("I press Escape in the file tree", async ({ app }) => {
  await fileTree(app.page).press("Escape")
})

Then("the file viewer shows {string} with {string}", async ({ app }, path: string, text: string) => {
  await expect(app.page.getByRole("region", { name: path, exact: true })).toContainText(text)
})

Then("the file viewer is closed", async ({ app }) => {
  await expect(app.page.getByRole("separator", { name: "Resize file viewer" })).toBeHidden()
})

Given("the file {string} contains {string} in my repository", ({ repo }, path: string, text: string) => {
  const file = join(repo, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${text}\n`)
})

When("I open Files in the activity bar", async ({ app }) => {
  await app.page.getByRole("tab", { name: "Files", exact: true }).click()
})

When("I click {string} in the file tree", async ({ app }, name: string) => {
  await fileTree(app.page).getByRole("treeitem", { name, exact: true }).click()
})

When("I append {string} to {string} while browsing files", ({ repo }, text: string, path: string) => {
  appendFileSync(join(repo, path), `${text}\n`)
})

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

Given("the image {string} exists in my repository", ({ repo }, path: string) => {
  writeFileSync(join(repo, path), Buffer.from(ONE_PIXEL_PNG, "base64"))
})

Then(
  "the file viewer renders the heading {string} and the image {string}",
  async ({ app }, heading: string, image: string) => {
    await expect(app.page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
    await expect(app.page.getByRole("img", { name: image, exact: true })).toHaveJSProperty("naturalWidth", 1)
  },
)

When("I click {string} in the file viewer", async ({ app }, button: string) => {
  await app.page.getByRole("button", { name: button, exact: true }).click()
})

const treeRow = (page: import("@playwright/test").Page, name: string) =>
  fileTree(page).getByRole("treeitem", { name, exact: true })

const pressOn = async (page: import("@playwright/test").Page, source: string) => {
  await treeRow(page, source).hover()
  await page.mouse.down()
}

// FIXME: over CDP Chromium fires dragover only on a move within the element a previous move entered, and the row's name is a child element
const dragOver = async (page: import("@playwright/test").Page, name: string) => {
  const row = treeRow(page, name)
  await expect(async () => {
    for (const x of [40, 44, 46, 48]) await row.hover({ position: { x, y: 12 } })
    await expect(row).toHaveAttribute("data-drop-target", "true", { timeout: 500 })
  }).toPass()
}

When(
  "I drag {string} onto {string} in the file tree and hold until it opens",
  async ({ app }, source: string, folder: string) => {
    await pressOn(app.page, source)
    await dragOver(app.page, folder)
    await expect(treeRow(app.page, folder)).toHaveAttribute("aria-expanded", "true")
  },
)

When("I drop on {string} in the file tree", async ({ app }, folder: string) => {
  await dragOver(app.page, folder)
  await app.page.mouse.up()
})

When("I drag {string} onto {string} in the file tree", async ({ app }, source: string, folder: string) => {
  await pressOn(app.page, source)
  await dragOver(app.page, folder)
  await app.page.mouse.up()
})

Then("the file {string} contains {string} on disk", async ({ repo }, path: string, text: string) => {
  const file = join(repo, path)
  await expect.poll(() => (existsSync(file) ? readFileSync(file, "utf8") : null)).toBe(`${text}\n`)
})

Then("I see the toast {string}", async ({ app }, text: string) => {
  await expect(app.page.getByRole("region", { name: /Notifications/ })).toContainText(text)
})

When("I create the file {string} from the file tree", async ({ app }, name: string) => {
  await app.page.getByRole("button", { name: "New file", exact: true }).click()
  await app.page.getByRole("textbox", { name: "New file name", exact: true }).fill(name)
  await app.page.keyboard.press("Enter")
  await expect(treeRow(app.page, name)).toBeVisible()
})

const mentions = (page: import("@playwright/test").Page) => page.getByRole("listbox", { name: "Mentions", exact: true })

Then("the mentions list is open", async ({ app }) => {
  await expect(mentions(app.page)).toBeVisible()
})

Then("the mentions list offers {string}", async ({ app }, path: string) => {
  await expect(mentions(app.page).getByRole("option").filter({ hasText: path })).toBeVisible()
})
