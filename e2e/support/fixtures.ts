import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect } from "@playwright/test"
import { createBdd, test as base } from "playwright-bdd"
import { defaultClientSettings } from "../../src/shared/domain.ts"
import { type KkcodeApp, spawnApp } from "./app.ts"
import type { Listener } from "./listener.ts"
import { rpc } from "./rpc.ts"
import { Seed } from "./seed.ts"

export interface Names {
  /** Suffixes a human-readable name so scenarios sharing a worker's app never collide. */
  readonly of: (name: string) => string
}

export interface AgentState {
  /** The MCP connection of the thread the scenario's agent acts as. */
  connection: { url: string; headers: { authorization: string } } | null
  /** The last tool result the agent received. */
  result: { isError: boolean; text: string } | null
}

export interface WebhookState {
  readonly automations: Map<string, { id: string; secret: string; url: string }>
  /** The last webhook response. */
  response: { status: number; body: string } | null
}

export interface ChosenModel {
  /** The label of the model the scenario picked from the agent's live list. */
  label: string | null
}

interface TestFixtures {
  readonly usageLimitApp: KkcodeApp
  readonly automaticResumeApp: KkcodeApp
  readonly orgSpendLimitApp: KkcodeApp
  readonly todoApp: KkcodeApp
  readonly names: Names
  /** A throwaway git repository on `main` with a README and a gitignored `.env`, inside the app's user-data directory. */
  readonly repo: string
  /** Project ids by display name, for the projects seeded during the scenario. */
  readonly projectIds: Map<string, string>
  /** Thread ids by display title, for the threads seeded during the scenario. */
  readonly threadIds: Map<string, string>
  /** TCP listeners the scenario started, by where they run; all are killed afterwards. */
  readonly listeners: Map<string, Listener>
  readonly agent: AgentState
  readonly webhook: WebhookState
  readonly chosenModel: ChosenModel
}

interface WorkerFixtures {
  readonly app: KkcodeApp
  readonly seed: Seed
}

// Playwright's `use` callback is not React's hook of the same name.
/* oxlint-disable react/rules-of-hooks, no-empty-pattern */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  usageLimitApp: async ({}, provide, testInfo) => {
    const app = await spawnApp({ mockClaude: "usage-limit", mockResetMs: 60_000 })
    try {
      await provide(app)
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("usage-limit-screenshot", { body: await app.page.screenshot(), contentType: "image/png" })
      }
    } finally {
      await app.close()
    }
  },
  automaticResumeApp: async ({}, provide, testInfo) => {
    const app = await spawnApp({ mockClaude: "usage-limit", mockResetMs: 5_000 })
    try {
      await provide(app)
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("automatic-resume-screenshot", {
          body: await app.page.screenshot(),
          contentType: "image/png",
        })
      }
    } finally {
      await app.close()
    }
  },
  orgSpendLimitApp: async ({}, provide, testInfo) => {
    const app = await spawnApp({ mockClaude: "org-spend-limit" })
    try {
      await provide(app)
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("org-spend-limit-screenshot", {
          body: await app.page.screenshot(),
          contentType: "image/png",
        })
      }
    } finally {
      await app.close()
    }
  },
  todoApp: async ({}, provide, testInfo) => {
    const app = await spawnApp({ mockClaude: "todos" })
    try {
      await provide(app)
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("todo-screenshot", { body: await app.page.screenshot(), contentType: "image/png" })
      }
    } finally {
      await app.close()
    }
  },
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
    writeFileSync(join(path, "README.md"), "# e2e\n")
    writeFileSync(join(path, ".gitignore"), ".env\n")
    writeFileSync(join(path, ".env"), "E2E_SECRET=from-root\n")
    execFileSync("git", ["init", "-q", "-b", "main", path])
    execFileSync("git", ["-C", path, "add", "README.md", ".gitignore"])
    execFileSync("git", [
      "-C",
      path,
      "-c",
      "user.email=e2e@kkcode",
      "-c",
      "user.name=e2e",
      "commit",
      "-q",
      "-m",
      "init",
    ])
    await provide(path)
  },
  projectIds: async ({}, provide) => provide(new Map()),
  threadIds: async ({}, provide) => provide(new Map()),
  listeners: async ({}, provide) => {
    const started = new Map<string, Listener>()
    await provide(started)
    for (const { pid } of started.values()) {
      try {
        process.kill(pid)
      } catch {
        // already gone, which some scenarios assert
      }
    }
  },
  agent: async ({}, provide) => provide({ connection: null, result: null }),
  webhook: async ({}, provide) => provide({ automations: new Map(), response: null }),
  chosenModel: async ({}, provide) => provide({ label: null }),
})
/* oxlint-enable react/rules-of-hooks, no-empty-pattern */

export const { Given, When, Then, AfterScenario } = createBdd(test)

/** Scenarios share a worker's app, so each one hands it back in English, unbound, on the Threads tab and on the home route. */
AfterScenario(async ({ app, $testInfo }) => {
  if ($testInfo.status !== $testInfo.expectedStatus) {
    await $testInfo.attach("screenshot", { body: await app.page.screenshot(), contentType: "image/png" })
  }
  await rpc(app.page, "settings.set", {
    defaultModel: { claude: null, codex: null, muse: null },
    archive: { whenMerged: false, removeWorktree: false },
  })
  await rpc(app.page, "clientSettings.set", {
    locale: "en",
    keybindings: {},
    appearance: defaultClientSettings.appearance,
  })
  await app.page.emulateMedia({ colorScheme: null })
  await app.page.evaluate(() => {
    localStorage.removeItem("kkcode.sidebarProjects")
    localStorage.removeItem("kkcode.sidebarTab")
  })
  await app.setWindow({ width: 1280, height: 820, zoom: 1 })
  await app.page.setViewportSize({ width: 1280, height: 820 })
  await app.reload()
  await expect(app.page.locator("html")).toHaveCSS("font-size", `${defaultClientSettings.appearance.fontSize}px`)
})
