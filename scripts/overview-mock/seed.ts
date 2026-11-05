import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../../src/main/db/client.ts"

const data = process.argv[2]
if (!data?.startsWith("/tmp/kk-")) throw new Error("Usage: node scripts/overview-mock/seed.ts /tmp/kk-<name>")

const database = join(data, "hinacode.sqlite")
if (existsSync(database)) {
  console.log(`${data} is already seeded`)
  process.exit(0)
}

const repo = join(data, "demo-web")
const worktreePath = join(data, "worktrees", "kk-fix-login")
const git = (...args: Array<string>) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" })

mkdirSync(repo, { recursive: true })
writeFileSync(
  join(repo, "package.json"),
  JSON.stringify({ name: "demo-web", scripts: { dev: "echo dev server on :3000", test: "echo 12 passed" } }, null, 2),
)
writeFileSync(join(repo, ".gitignore"), ".env\n")
writeFileSync(join(repo, ".env"), "API_URL=http://localhost:3000\n")
execFileSync("git", ["init", "-q", "-b", "main", repo])
git("add", ".")
git("-c", "user.name=HinaCode", "-c", "user.email=demo@example.com", "commit", "-qm", "chore: start demo-web")
git("worktree", "add", "-q", "-b", "kk/fix-login", worktreePath)

const setupLog = [
  "$ pnpm install --frozen-lockfile",
  "Lockfile is up to date, resolution step is skipped",
  "Packages: +412",
  "Done in 3.2s using pnpm v10.12.1",
  "$ cp $HINACODE_ROOT_PATH/.env .env",
].join("\n")

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = Date.now()
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const projectId = randomUUID()
  const worktreeId = randomUUID()

  yield* sql`INSERT INTO project ${sql.insert({
    id: projectId,
    name: "demo-web",
    rootPath: repo,
    setupScript: "pnpm install --frozen-lockfile\ncp $HINACODE_ROOT_PATH/.env .env",
    actions: JSON.stringify([
      { name: "Dev server", command: "pnpm dev" },
      { name: "Unit tests", command: "pnpm test" },
      { name: "Show the setup variables", command: "echo $HINACODE_ROOT_PATH $HINACODE_WORKTREE_PATH" },
    ]),
    createdAt: at(60),
    updatedAt: at(60),
  })}`
  yield* sql`INSERT INTO worktree ${sql.insert({
    id: worktreeId,
    projectId,
    path: worktreePath,
    branch: "kk/fix-login",
    baseRef: "main",
    status: "ready",
    setupLog,
    createdAt: at(50),
  })}`
  const threads = [
    { title: "Fix login redirect", worktreeId, minutesAgo: 5 },
    { title: "Audit the composer", worktreeId: null, minutesAgo: 12 },
    { title: "Investigate the flaky macOS job", worktreeId: null, minutesAgo: 30, pinnedAt: at(20) },
    { title: "Rewrite the arch diagram", worktreeId: null, minutesAgo: 45 },
  ]
  const linkedPullRequests = [448, 447, 446].map((number) => `https://github.com/hinadev-ai/hinacode/pull/${number}`)
  for (const [index, thread] of threads.entries()) {
    const threadId = randomUUID()
    yield* sql`INSERT INTO thread ${sql.insert({
      id: threadId,
      projectId,
      worktreeId: thread.worktreeId,
      title: thread.title,
      model: "claude-sonnet-5-5",
      provider: "claude",
      status: "idle",
      sortIndex: index,
      pinnedAt: thread.pinnedAt ?? null,
      createdAt: at(thread.minutesAgo),
      updatedAt: at(thread.minutesAgo),
    })}`
    if (index > 0) continue
    for (const url of linkedPullRequests) {
      yield* sql`INSERT INTO pull_request_link ${sql.insert({ id: randomUUID(), threadId, url, createdAt: at(4) })}`
    }
  }
})

await Effect.runPromise(seed.pipe(Effect.provide(Db.layer(database))))
console.log(`Seeded ${data}. Send any message in a thread to start the mock sub-agents.`)
