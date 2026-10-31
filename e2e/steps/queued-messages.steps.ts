import { expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { QueuedMessage } from "../../src/shared/domain.ts"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"
import { composerText } from "../support/ui.ts"
import { SEEDED_AT } from "../support/seed.ts"

const queuedText = "Queued follow-up"
const attachmentName = "queued-note.txt"

Given(
  "the project {string} has an archived thread {string} with a queued message and attachment",
  async ({ app, seed, names, projectIds, threadIds }, project: string, title: string) => {
    const projectId = projectIds.get(project)
    if (!projectId) throw new Error(`no seeded project named ${project}`)
    const threadId = seed.thread({ projectId, title: names.of(title) })
    threadIds.set(title, threadId)
    const path = join(app.userData, attachmentName)
    writeFileSync(path, "Context kept with the queued message.")
    const attachment = await rpc(app.page, "attachments.stage", { threadId, source: { path } })
    const queued: QueuedMessage = { id: randomUUID(), text: queuedText, attachments: [attachment] }
    const now = SEEDED_AT
    const db = new DatabaseSync(app.dbPath)
    try {
      db.prepare("UPDATE thread SET status = 'archived', queue = ? WHERE id = ?").run(
        JSON.stringify([queued]),
        threadId,
      )
      db.prepare(
        "INSERT INTO message(id, thread_id, role, parts, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(randomUUID(), threadId, "user", JSON.stringify([{ type: "text", text: "Earlier prompt" }]), now, now)
    } finally {
      db.close()
    }
    await app.reload()
  },
)

When("I compose the draft {string}", async ({ app }, text: string) => {
  await app.page.getByLabel("Message", { exact: true }).fill(text)
})

When("I steer the queued message now", async ({ app }) => {
  await app.page
    .getByRole("list", { name: "Queued messages", exact: true })
    .getByRole("button", { name: "Steer now", exact: true })
    .click()
})

Then(
  "the queued message is restored beside {string} with both attachments",
  async ({ app, threadIds }, draft: string) => {
    await expect(app.page.getByRole("alert").filter({ hasText: "Cannot send to an archived thread" })).toBeVisible()
    const composer = app.page.getByLabel("Message", { exact: true })
    await expect.poll(() => composerText(composer)).toBe(`${queuedText}\n${draft}`)
    await expect(composer).toBeFocused()
    await expect(app.page.getByRole("button", { name: `Remove ${attachmentName}`, exact: true })).toBeVisible()
    await expect(app.page.getByRole("button", { name: "Remove image-0.png", exact: true })).toBeVisible()
    await expect(app.page.getByRole("list", { name: "Queued messages", exact: true })).toBeHidden()
    const threads = await rpc(app.page, "threads.list", undefined)
    expect(threads.find((thread) => thread.id === threadIds.get("Queued"))?.queue).toEqual([])
  },
)
