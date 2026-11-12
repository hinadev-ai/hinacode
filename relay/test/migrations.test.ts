import { env } from "cloudflare:workers"
import { expect, it } from "vitest"

it("applies every migration in order on a fresh database", async () => {
  const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()

  expect(applied.results.map((row) => row.name)).toEqual(env.TEST_MIGRATIONS.map((migration) => migration.name))
  expect(applied.results.map((row) => row.name)).toEqual(applied.results.map((row) => row.name).toSorted())
})

it("leaves no owner table once the device migration replaced it", async () => {
  const owner = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner'").first()

  expect(owner).toBeNull()
})
