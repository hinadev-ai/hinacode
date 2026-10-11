import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createBdd, test as base } from "playwright-bdd"
import { type KkcodeApp, spawnApp } from "./app.ts"
import { rpc } from "./rpc.ts"
import { Seed } from "./seed.ts"

export interface Names {
  /** Suffixes a human-readable name so scenarios sharing a worker's app never collide. */
  readonly of: (name: string) => string
}

interface TestFixtures {
  readonly names: Names
  /** A throwaway git repository on `main` with one commit, inside the app's user-data directory. */
  readonly repo: string
  /** Project ids by display name, for the ids seeded during the scenario. */
  readonly projectIds: Map<string, string>
}

interface WorkerFixtures {
  readonly app: KkcodeApp
  readonly seed: Seed
}

// Playwright's `use` callback is not React's hook of the same name.
/* oxlint-disable react/rules-of-hooks, no-empty-pattern */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  app: [
    async ({}, provide) => {
      const app = await spawnApp()
      try {
        await provide(app)
      } finally {
        await app.close()
      }
    },
    { scope: "worker" },
  ],
  seed: [async ({ app }, provide) => provide(new Seed(app.dbPath)), { scope: "worker" }],
  names: async ({}, provide) => {
    const suffix = randomBytes(3).toString("hex")
    await provide({ of: (name) => `${name}-${suffix}` })
  },
  repo: async ({ app, names }, provide) => {
    const path = join(app.userData, "repos", names.of("repo"))
    mkdirSync(path, { recursive: true })
    execFileSync("git", ["init", "-q", "-b", "main", path])
    execFileSync("git", [
      "-C",
      path,
      "-c",
      "user.email=e2e@kkcode",
      "-c",
      "user.name=e2e",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ])
    await provide(path)
  },
  projectIds: async ({}, provide) => provide(new Map()),
})
/* oxlint-enable react/rules-of-hooks, no-empty-pattern */

export const { Given, When, Then, AfterScenario } = createBdd(test)

/** Scenarios share a worker's app, so each one hands it back in English, unbound and on the home route. */
AfterScenario(async ({ app, $testInfo }) => {
  if ($testInfo.status !== $testInfo.expectedStatus) {
    await $testInfo.attach("screenshot", { body: await app.page.screenshot(), contentType: "image/png" })
  }
  await rpc(app.page, "settings.set", { locale: "en", keybindings: {} })
  await app.reload()
})
