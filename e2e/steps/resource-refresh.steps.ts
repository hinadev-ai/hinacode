import { expect } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { When, Then } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

When("the open thread starts a turn", async ({ app }) => {
  const title = await app.page.getByRole("heading", { level: 1 }).textContent()
  const thread = (await rpc(app.page, "threads.list", undefined)).find((candidate) => candidate.title === title)
  if (!thread) throw new Error(`No open thread ${title}`)
  await app.pushEvents([{ type: "thread.updated", thread: { ...thread, status: "running" } }])
  await expect(app.page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
})

When("the open thread finishes its turn", async ({ app }) => {
  const title = await app.page.getByRole("heading", { level: 1 }).textContent()
  const thread = (await rpc(app.page, "threads.list", undefined)).find((candidate) => candidate.title === title)
  if (!thread) throw new Error(`No open thread ${title}`)
  await app.pushEvents([{ type: "thread.updated", thread: { ...thread, status: "idle" } }])
  await expect(app.page.getByRole("button", { name: "Send", exact: true })).toBeVisible()
})

When("I commit {string} in my repository", ({ repo }, subject: string) => {
  execFileSync("git", ["-C", repo, "add", "-A"])
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=e2e",
    "-c",
    "user.email=e2e@kkcode",
    "commit",
    "--allow-empty",
    "-qm",
    subject,
  ])
})

Then("the commit graph lists {string}", async ({ app }, subject: string) => {
  await expect(
    app.page
      .getByRole("listbox", { name: "Commit history" })
      .getByRole("option", { name: new RegExp(`^${subject} by `) }),
  ).toBeVisible()
})

Then("the Changes view is empty", async ({ app }) => {
  await expect(app.page.getByRole("tabpanel", { name: "Changes", exact: true })).toContainText("No changes.")
})

Then("the file tree shows {string} as unchanged", async ({ app }, path: string) => {
  const entry = app.page
    .getByRole("tree", { name: "Workspace files" })
    .getByRole("treeitem", { name: path, exact: true })
  await expect(entry).toHaveAccessibleDescription("")
})

Then("mentioning a file offers {string}", async ({ app }, path: string) => {
  await app.page.getByRole("combobox", { name: "Message", exact: true }).fill(`@${path}`)
  await expect(app.page.getByRole("option", { name: path, exact: true })).toBeVisible()
})
