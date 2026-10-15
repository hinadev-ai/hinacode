import { expect, type Page } from "@playwright/test"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"
import { sidebar } from "../support/ui.ts"

const addProjectDialog = async (page: Page, rootPath: string, name: string) => {
  await page.getByRole("button", { name: "Add project", exact: true }).first().click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Folder or GitHub repository", { exact: true }).fill(rootPath)
  await dialog.getByLabel("Name", { exact: true }).fill(name)
  await dialog.getByRole("button", { name: "Add project", exact: true }).click()
  return dialog
}

Given("a project {string} for my repository", async ({ app, seed, repo, names, projectIds }, name: string) => {
  projectIds.set(name, seed.project({ name: names.of(name), rootPath: repo }))
  await app.reload()
})

Given(
  "a project {string} for my repository with the setup script {string}",
  async ({ app, seed, repo, names, projectIds }, name: string, setupScript: string) => {
    projectIds.set(name, seed.project({ name: names.of(name), rootPath: repo, setupScript }))
    await app.reload()
  },
)

Given(
  "the project {string} has a thread {string}",
  async ({ app, seed, names, projectIds, threadIds }, project: string, title: string) => {
    const projectId = projectIds.get(project)
    if (!projectId) throw new Error(`no seeded project named ${project}`)
    threadIds.set(title, seed.thread({ projectId, title: names.of(title) }))
    await app.reload()
  },
)

Given(
  "another project {string} has a thread {string}",
  async ({ app, seed, names, projectIds, threadIds }, project: string, title: string) => {
    const rootPath = join(app.userData, "repos", names.of(project))
    mkdirSync(rootPath, { recursive: true })
    const projectId = seed.project({ name: names.of(project), rootPath })
    projectIds.set(project, projectId)
    threadIds.set(title, seed.thread({ projectId, title: names.of(title) }))
    await app.reload()
  },
)

When(
  "I add a project named {string} for my repository through the dialog",
  async ({ app, repo, names }, name: string) => {
    const dialog = await addProjectDialog(app.page, repo, names.of(name))
    await expect(dialog).toBeHidden()
  },
)

When("I add a project named {string} at a path that does not exist", async ({ app, names }, name: string) => {
  const dialog = await addProjectDialog(app.page, join(app.userData, "new", names.of(name)), names.of(name))
  await expect(dialog).toBeHidden()
})

When("I try to add a project named {string} at a path that is a file", async ({ app, names }, name: string) => {
  const file = join(app.userData, "notes.txt")
  writeFileSync(file, "")
  await addProjectDialog(app.page, file, names.of(name))
})

When("I try to add another project named {string} for my repository", async ({ app, repo, names }, name: string) => {
  await addProjectDialog(app.page, repo, names.of(name))
})

Then("the add project dialog shows the error {string}", async ({ app }, text: string) => {
  await expect(app.page.getByRole("dialog").getByRole("alert")).toHaveText(text)
})

Then("the sidebar lists the project {string}", async ({ app, names }, name: string) => {
  await expect(
    sidebar(app.page).getByRole("button", { name: `New thread in ${names.of(name)}`, exact: true }),
  ).toBeVisible()
})

Then("the project {string} is stored with my repository path", async ({ app, repo, names }, name: string) => {
  const projects = await rpc(app.page, "projects.list", undefined)
  expect(projects.find((project) => project.name === names.of(name))?.rootPath).toBe(repo)
})

Then("the project {string} has a folder on disk", async ({ app, names }, name: string) => {
  const projects = await rpc(app.page, "projects.list", undefined)
  const rootPath = projects.find((project) => project.name === names.of(name))?.rootPath
  expect(rootPath).toBe(join(app.userData, "new", names.of(name)))
  expect(statSync(rootPath ?? "").isDirectory()).toBe(true)
})
