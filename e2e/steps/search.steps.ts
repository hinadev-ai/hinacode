import { expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Given, Then, When } from "../support/fixtures.ts"
import { SEEDED_AT } from "../support/seed.ts"

Given(
  "the thread {string} and its workspace each have {int} search match(es)",
  async ({ app, names, threadIds, repo }, title: string, count: number) => {
    const threadId = threadIds.get(title)
    if (!threadId) throw new Error(`Thread ${title} was not seeded`)
    const query = names.of("refresh-search")
    const db = new DatabaseSync(app.dbPath)
    try {
      db.prepare("DELETE FROM message WHERE thread_id = ?").run(threadId)
      const insert = db.prepare(
        "INSERT INTO message(id, thread_id, role, parts, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      const now = SEEDED_AT
      for (let index = 0; index < count; index++) {
        insert.run(
          randomUUID(),
          threadId,
          "assistant",
          JSON.stringify([{ type: "text", text: `${query} message ${index}` }]),
          now,
          now,
        )
      }
    } finally {
      db.close()
    }
    writeFileSync(
      join(repo, "search.txt"),
      Array.from({ length: count }, (_, index) => `${query} file line ${index}\n`).join(""),
    )
  },
)

When("I search for the refresh query", async ({ app, names }) => {
  await app.page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Search", exact: true })
    .fill(`%${names.of("refresh-search")}`)
})

Then("global search shows {int} results", async ({ app }, count: number) => {
  await expect(app.page.getByRole("option")).toHaveCount(count)
})
