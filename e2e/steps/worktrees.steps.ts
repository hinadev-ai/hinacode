import { expect } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"
import { threadDetails } from "../support/ui.ts"

const branchOf = (title: string) => `kk/${title.replace(/\s+/g, "-")}`

/** The worktree of the open thread, read back from main. */
const openWorktree = async (page: import("@playwright/test").Page) => {
  const title = await page.getByRole("heading", { level: 1 }).textContent()
  const thread = (await rpc(page, "threads.list", undefined)).find((candidate) => candidate.title === title)
  const worktree = (await rpc(page, "worktrees.list", undefined)).find(
    (candidate) => candidate.id === thread?.worktreeId,
  )
  if (!worktree) throw new Error(`the open thread ${title} has no worktree`)
  return worktree
}

const gitWorktrees = (repo: string) =>
  execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" })

When(
  "I create a thread titled {string} in {string} in a new worktree",
  async ({ app, names }, title: string, project: string) => {
    const page = app.page
    await page.getByRole("button", { name: `New thread in ${names.of(project)}`, exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Title", { exact: true }).fill(names.of(title))
    await dialog.getByRole("switch", { name: "Run in a new worktree", exact: true }).click()
    // The branch follows the title; the base ref fills in once main reports the current branch.
    await expect(dialog.getByLabel("Branch", { exact: true })).toHaveValue(branchOf(names.of(title)))
    await expect(dialog.getByLabel("Base ref", { exact: true })).toHaveValue("main")
    await expect(dialog.getByLabel("Model", { exact: true })).toBeEnabled({ timeout: 30_000 })
    await dialog.getByRole("button", { name: "Create thread", exact: true }).click()
    await expect(dialog).toBeHidden()
  },
)

When("I change {string} and add {string} in the worktree", async ({ app }, changed: string, added: string) => {
  const { path } = await openWorktree(app.page)
  appendFileSync(join(path, changed), "change\n")
  writeFileSync(join(path, added), "new\n")
})

When("I refresh the changes", async ({ app }) => {
  const panel = await threadDetails(app.page)
  await panel.getByRole("button", { name: "Refresh changes", exact: true }).click()
})

When("I open the diff of {string}", async ({ app }, file: string) => {
  const panel = await threadDetails(app.page)
  await panel.getByRole("region", { name: "Changes" }).getByRole("button").filter({ hasText: file }).click()
})

When("I settle the thread and clean up its worktree", async ({ app }) => {
  const panel = await threadDetails(app.page)
  await panel.getByRole("button", { name: "Settle and clean up", exact: true }).click()
  const dialog = app.page.getByRole("alertdialog")
  await expect(dialog).toContainText("Settle this thread?")
  await dialog.getByRole("button", { name: "Settle and delete worktree", exact: true }).click()
  await expect(dialog).toBeHidden()
})

Then("the workspace status becomes {string}", async ({ app }, status: string) => {
  const panel = await threadDetails(app.page)
  await expect(panel.getByRole("region", { name: "Workspace" }).getByText(status, { exact: true })).toBeVisible()
})

Then("the setup log ends with the branch of {string}", async ({ app, names }, title: string) => {
  const panel = await threadDetails(app.page)
  const log = panel.getByRole("log", { name: "Setup log" })
  await expect
    .poll(async () => (await log.textContent())?.trimEnd())
    .toMatch(new RegExp(`setup ok on ${branchOf(names.of(title))}$`))
})

When("I commit a change in the worktree", async ({ app }) => {
  const { path } = await openWorktree(app.page)
  appendFileSync(join(path, "README.md"), "committed\n")
  execFileSync("git", ["-C", path, "-c", "user.email=e2e@kkcode", "-c", "user.name=e2e", "commit", "-qam", "work"])
})

Then("the setup log reports that the script exited with code {int}", async ({ app }, code: number) => {
  const panel = await threadDetails(app.page)
  await expect(panel.getByRole("alert")).toContainText("The setup script failed")
  await expect(panel.getByRole("log", { name: "Setup log" })).toContainText(`exited with code ${code}`)
})

Then("the worktree has a copy of my repository's {string}", async ({ app }, file: string) => {
  const { path } = await openWorktree(app.page)
  expect(existsSync(join(path, file))).toBe(true)
})

Then("git lists the worktree on the branch {string}", async ({ app, repo, names }, branch: string) => {
  const { path } = await openWorktree(app.page)
  const listed = gitWorktrees(repo)
  expect(listed).toContain(`worktree ${path}`)
  expect(listed).toContain(`branch refs/heads/${branchOf(names.of(branch))}`)
})

Then(
  "the changes list {string} as modified and {string} as untracked",
  async ({ app }, modified: string, untracked: string) => {
    const panel = await threadDetails(app.page)
    const changes = panel.getByRole("region", { name: "Changes" })
    await expect(changes.getByRole("button").filter({ hasText: modified }).getByTitle("Modified")).toBeVisible()
    await expect(
      changes.getByRole("button").filter({ hasText: untracked }).getByTitle("New, not tracked"),
    ).toBeVisible()
  },
)

Then("the diff of {string} shows {string}", async ({ app }, file: string, text: string) => {
  const panel = await threadDetails(app.page)
  await expect(
    panel.getByRole("region", { name: "Changes" }).getByRole("listitem").filter({ hasText: file }),
  ).toContainText(text)
})

Then("the worktree is removed from disk but its branch is kept", async ({ app, repo }) => {
  const panel = await threadDetails(app.page)
  await expect(panel.getByText("The worktree was removed. New runs use the project root.")).toBeVisible()
  const { path, branch } = await openWorktree(app.page)
  // Deletion of the checkout finishes in the background after the row is marked removed.
  await expect.poll(() => existsSync(path)).toBe(false)
  expect(gitWorktrees(repo)).not.toContain(`worktree ${path}`)
  expect(execFileSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" })).toContain(branch)
})
