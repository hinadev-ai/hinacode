import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "./db/client.ts"
import { seedThread } from "./db/testing.ts"
import { moveLegacyProfile } from "./dataDir.ts"

const seedLegacyProfile = async (legacy: string) => {
  mkdirSync(join(legacy, "Local Storage"), { recursive: true })
  writeFileSync(join(legacy, "Local Storage", "000003.log"), "")
  writeFileSync(join(legacy, "Preferences"), "{}")
  const image = join(legacy, "attachments", "t", "shot.png")
  mkdirSync(join(legacy, "attachments", "t"), { recursive: true })
  writeFileSync(image, "png")
  const configDir = join(legacy, "accounts", "a1")
  mkdirSync(configDir, { recursive: true })
  const attachment = { id: "x", name: "shot.png", path: image, mime: "image/png", kind: "image", bytes: 3 }
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { threadId } = yield* seedThread({ rootPath: join(legacy, "chats") })
      const now = "2026-10-01T00:00:00.000Z"
      yield* sql`INSERT INTO message ${sql.insert({ id: "m1", threadId, role: "user", parts: JSON.stringify([{ type: "attachment", attachment }]), createdAt: now })}`
      yield* sql`UPDATE thread SET queue = ${JSON.stringify([{ id: "q1", text: "next", attachments: [attachment] }])}`
      yield* sql`INSERT INTO agent_account ${sql.insert({ id: "a1", provider: "claude", name: "work", createdAt: now, configDir, binary: "claude" })}`
    }).pipe(Effect.provide(Db.layer(join(legacy, "hinacode.sqlite")))),
  )
}

describe("moveLegacyProfile", () => {
  it("moves Chromium's files under chromium/, HinaCode's to the top, and rewrites stored paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "kk-data-dir-"))
    const legacy = join(home, "Library", "Application Support", "kkcode")
    const dataDir = join(home, ".hinacode")
    await seedLegacyProfile(legacy)

    moveLegacyProfile(legacy, dataDir)

    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(join(dataDir, "chromium", "Preferences"))).toBe(true)
    expect(existsSync(join(dataDir, "chromium", "Local Storage", "000003.log"))).toBe(true)
    expect(existsSync(join(dataDir, "chromium", "hinacode.sqlite"))).toBe(false)
    expect(existsSync(join(dataDir, "attachments", "t", "shot.png"))).toBe(true)
    expect(existsSync(join(dataDir, "accounts", "a1"))).toBe(true)

    const db = new DatabaseSync(join(dataDir, "hinacode.sqlite"))
    const image = join(dataDir, "attachments", "t", "shot.png")
    const [part] = JSON.parse(String(db.prepare("SELECT parts FROM message").get()?.["parts"]))
    expect(part.attachment.path).toBe(image)
    const [queued] = JSON.parse(String(db.prepare("SELECT queue FROM thread").get()?.["queue"]))
    expect(queued.attachments[0].path).toBe(image)
    expect(db.prepare("SELECT config_dir FROM agent_account").get()?.["config_dir"]).toBe(
      join(dataDir, "accounts", "a1"),
    )
    db.close()
  })

  it("leaves an existing data dir alone", () => {
    const home = mkdtempSync(join(tmpdir(), "kk-data-dir-"))
    const legacy = join(home, "kkcode")
    const dataDir = join(home, ".hinacode")
    mkdirSync(legacy)
    writeFileSync(join(legacy, "Preferences"), "{}")
    mkdirSync(dataDir)

    moveLegacyProfile(legacy, dataDir)

    expect(existsSync(join(legacy, "Preferences"))).toBe(true)
    expect(existsSync(join(dataDir, "chromium"))).toBe(false)
  })
})
