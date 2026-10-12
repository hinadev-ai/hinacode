import { expect } from "@playwright/test"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
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
