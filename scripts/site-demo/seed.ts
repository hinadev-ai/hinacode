import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../../src/main/db/client.ts"

const data = process.argv[2]
if (!data?.startsWith("/tmp/kk-")) throw new Error("Usage: node scripts/site-demo/seed.ts /tmp/kk-<name>")

const database = join(data, "hinacode.sqlite")
if (existsSync(database)) throw new Error(`${data} is already seeded. Delete it to start over.`)

const commit = (repo: string, message: string) => {
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=HinaCode",
    "-c",
    "user.email=demo@example.com",
    "commit",
    "-qm",
    message,
  ])
}

const writeFiles = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

const createRepo = (name: string, files: Record<string, string>, remote?: string) => {
  const repo = join(data, name)
  mkdirSync(repo, { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  writeFiles(repo, files)
  commit(repo, `chore: start ${name}`)
  if (remote) execFileSync("git", ["-C", repo, "remote", "add", "origin", remote])
  return repo
}

const addWorktree = (repo: string, branch: string, changes: Record<string, string>) => {
  const path = join(data, "worktrees", branch.replace("/", "-"))
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, path])
  writeFiles(path, changes)
  return path
}

const loginSpec = (wait: string) => `import { expect, test } from "@playwright/test"

test("signs in with email", async ({ page }) => {
  await page.goto("/login")
  await page.getByLabel("Email").fill("ada@example.com")
  await page.getByLabel("Password").fill("correct horse")
  await page.getByRole("button", { name: "Sign in" }).click()
${wait}
  await expect(page).toHaveURL("/dashboard")
})
`

const web = createRepo("acme-web", {
  "package.json": JSON.stringify(
    {
      name: "acme-web",
      scripts: { dev: "vite", build: "vite build", "test:e2e": "playwright test" },
      devDependencies: { vite: "7.3.7" },
    },
    null,
    2,
  ),
  "e2e/login.spec.ts": loginSpec("  await page.waitForTimeout(500)"),
  "src/main.ts": 'import "./styles.css"\n',
  "messages/en.json": '{\n  "settings_title": "Settings"\n}\n',
})
const api = createRepo("acme-api", {
  "package.json": JSON.stringify({ name: "acme-api", scripts: { test: "vitest run" } }, null, 2),
  "src/routes/reports.ts": 'export const reports = new Hono().get("/", listReports)\n',
})
const hinacode = createRepo(
  "hinacode",
  { "README.md": "# HinaCode\n", "site/package.json": '{ "name": "hinacode-site" }\n' },
  "https://github.com/hinadev-ai/hinacode.git",
)

const worktrees = {
  login: addWorktree(web, "fix/flaky-login", {
    "e2e/login.spec.ts": loginSpec('  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()'),
  }),
  vite: addWorktree(web, "chore/vite-8", {
    "package.json": JSON.stringify(
      {
        name: "acme-web",
        scripts: { dev: "vite", build: "vite build", "test:e2e": "playwright test" },
        devDependencies: { vite: "8.0.2" },
      },
      null,
      2,
    ),
  }),
  csv: addWorktree(api, "feat/csv-export", {
    "src/csv.ts":
      'export const toCsv = (rows: ReadonlyArray<Record<string, unknown>>) =>\n  rows.map((row) => Object.values(row).map(quote).join(",")).join("\\n")\n',
    "src/routes/reports.ts":
      'export const reports = new Hono().get("/", listReports).get("/export.csv", exportReports)\n',
  }),
}

const setupLog = ["$ pnpm install --frozen-lockfile", "Packages: +412", "Done in 3.2s using pnpm v10.12.1"].join("\n")

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = Date.now()
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()

  const projects = { web: randomUUID(), api: randomUUID(), hinacode: randomUUID() }
  for (const [key, rootPath, name] of [
    ["web", web, "acme-web"],
    ["api", api, "acme-api"],
    ["hinacode", hinacode, "hinacode"],
  ] as const) {
    yield* sql`INSERT INTO project ${sql.insert({
      id: projects[key],
      name,
      rootPath,
      setupScript: "pnpm install --frozen-lockfile",
      actions: JSON.stringify([{ name: "Dev server", command: "pnpm dev" }]),
      createdAt: at(600),
      updatedAt: at(600),
    })}`
  }

  const worktreeIds = { login: randomUUID(), vite: randomUUID(), csv: randomUUID() }
  for (const [key, projectId, branch] of [
    ["login", projects.web, "fix/flaky-login"],
    ["vite", projects.web, "chore/vite-8"],
    ["csv", projects.api, "feat/csv-export"],
  ] as const) {
    yield* sql`INSERT INTO worktree ${sql.insert({
      id: worktreeIds[key],
      projectId,
      path: worktrees[key],
      branch,
      baseRef: "main",
      status: "ready",
      setupLog,
      createdAt: at(90),
    })}`
  }

  const threads = [
    {
      title: "Fix the flaky login test",
      project: projects.web,
      worktree: worktreeIds.login,
      provider: "claude",
      minutesAgo: 2,
    },
    {
      title: "Add a CSV export to reports",
      project: projects.api,
      worktree: worktreeIds.csv,
      provider: "codex",
      minutesAgo: 3,
    },
    { title: "Upgrade to Vite 8", project: projects.web, worktree: worktreeIds.vite, provider: "muse", minutesAgo: 25 },
    {
      title: "Translate settings to Japanese",
      project: projects.web,
      worktree: null,
      provider: "claude",
      minutesAgo: 70,
    },
    {
      title: "Rebuild the site around a working demo",
      project: projects.hinacode,
      worktree: null,
      provider: "claude",
      minutesAgo: 40,
      pullRequest: 474,
    },
    {
      title: "Render HTML in PR discussion",
      project: projects.hinacode,
      worktree: null,
      provider: "codex",
      minutesAgo: 300,
      pullRequest: 468,
    },
  ]
  const models = { claude: "claude-sonnet-5-5", codex: "gpt-5.5", muse: "muse-1" }
  for (const [index, thread] of threads.entries()) {
    const threadId = randomUUID()
    yield* sql`INSERT INTO thread ${sql.insert({
      id: threadId,
      projectId: thread.project,
      worktreeId: thread.worktree,
      title: thread.title,
      model: models[thread.provider as keyof typeof models],
      provider: thread.provider,
      status: "idle",
      sortIndex: index,
      pinnedAt: null,
      createdAt: at(thread.minutesAgo),
      updatedAt: at(thread.minutesAgo),
    })}`
    if (thread.pullRequest) {
      const url = `https://github.com/hinadev-ai/hinacode/pull/${thread.pullRequest}`
      yield* sql`INSERT INTO pull_request_link ${sql.insert({ id: randomUUID(), threadId, url, createdAt: at(thread.minutesAgo) })}`
    }
  }
})

await Effect.runPromise(seed.pipe(Effect.provide(Db.layer(database))))
console.log(`Seeded ${data}`)
