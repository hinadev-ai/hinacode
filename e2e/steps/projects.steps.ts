import { expect } from "@playwright/test"
import { join } from "node:path"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const addProjectDialog = async (
  { page }: { page: import("@playwright/test").Page },
  rootPath: string,
  name: string,
) => {
  await page.getByRole("button", { name: "Add project", exact: true }).first().click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Root path", { exact: true }).fill(rootPath)
  await dialog.getByLabel("Name", { exact: true }).fill(name)
  await dialog.getByRole("button", { name: "Add project", exact: true }).click()
  return dialog
}

Given("a project {string} for my repository", async ({ app, seed, repo, names, projectIds }, name: string) => {
  projectIds.set(name, seed.project({ name: names.of(name), rootPath: repo }))
  await app.reload()
})

Given(
  "the project {string} has a thread {string}",
  async ({ app, seed, names, projectIds }, project: string, title: string) => {
    const projectId = projectIds.get(project)
    if (!projectId) throw new Error(`no seeded project named ${project}`)
    seed.thread({ projectId, title: names.of(title) })
    await app.reload()
  },
)

When(
  "I add a project named {string} for my repository through the dialog",
  async ({ app, repo, names }, name: string) => {
    const dialog = await addProjectDialog(app, repo, names.of(name))
    await expect(dialog).toBeHidden()
  },
)

When("I try to add a project named {string} at a path that does not exist", async ({ app, names }, name: string) => {
  await addProjectDialog(app, join(app.userData, "missing"), names.of(name))
})

Then("the add project dialog shows the error {string}", async ({ app }, text: string) => {
  await expect(app.page.getByRole("dialog").getByRole("alert")).toHaveText(text)
})

Then("the sidebar lists the project {string}", async ({ app, names }, name: string) => {
  const sidebar = app.page.getByRole("navigation", { name: "Projects and threads" })
  await expect(sidebar.getByRole("button", { name: `New thread in ${names.of(name)}`, exact: true })).toBeVisible()
})

Then("the project {string} is stored with my repository path", async ({ app, repo, names }, name: string) => {
  const projects = await rpc(app.page, "projects.list", undefined)
  expect(projects.find((project) => project.name === names.of(name))?.rootPath).toBe(repo)
})
