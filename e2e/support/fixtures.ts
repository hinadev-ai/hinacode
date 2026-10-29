import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect } from "@playwright/test"
import { createBdd, test as base } from "playwright-bdd"
import { defaultClientSettings } from "../../src/shared/domain.ts"
import { type HinacodeApp, spawnApp } from "./app.ts"
import type { Listener } from "./listener.ts"
import { rpc } from "./rpc.ts"
import { Seed } from "./seed.ts"

export interface Names {
  readonly of: (name: string) => string
}

export interface AgentState {
  connection: { url: string; headers: { authorization: string } } | null
  result: { isError: boolean; text: string } | null
}

export interface WebhookState {
  readonly automations: Map<string, { id: string; secret: string; url: string }>
  response: { status: number; body: string } | null
}

export interface ChosenModel {
  label: string | null
}

interface TestFixtures {
  readonly usageLimitApp: HinacodeApp
  readonly automaticResumeApp: HinacodeApp
  readonly orgSpendLimitApp: HinacodeApp
  readonly todoApp: HinacodeApp
  readonly activityApp: HinacodeApp
  readonly names: Names
  readonly repo: string
  readonly projectIds: Map<string, string>
  readonly threadIds: Map<string, string>
  readonly listeners: Map<string, Listener>
  readonly agent: AgentState
  readonly webhook: WebhookState
  readonly chosenModel: ChosenModel
}

interface WorkerFixtures {
  readonly app: HinacodeApp
  readonly seed: Seed
}

// FIXME: react/rules-of-hooks mistakes Playwright's use callback for React's hook
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
    const app = await spawnApp({ mockClaude: "usage-limit", mockResetMs: -55_000 })
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
  activityApp: async ({}, provide, testInfo) => {
    const app = await spawnApp({ mockClaude: "activity" })
    try {
      await provide(app)
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("activity-screenshot", { body: await app.page.screenshot(), contentType: "image/png" })
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
      "user.email=e2e@hinacode",
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
      } catch {}
    }
  },
  agent: async ({}, provide) => provide({ connection: null, result: null }),
  webhook: async ({}, provide) => provide({ automations: new Map(), response: null }),
  chosenModel: async ({}, provide) => provide({ label: null }),
})
/* oxlint-enable react/rules-of-hooks, no-empty-pattern */

export const { Given, When, Then, AfterScenario } = createBdd(test)

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
    localStorage.removeItem("hinacode.sidebarProjects")
    localStorage.removeItem("hinacode.sidebarTab")
    localStorage.removeItem("hinacode.location")
  })
  await app.setWindow({ width: 1280, height: 820, zoom: 1 })
  await app.page.setViewportSize({ width: 1280, height: 820 })
  await app.reload()
  await expect(app.page.locator("html")).toHaveCSS("font-size", `${defaultClientSettings.appearance.fontSize}px`)
})
