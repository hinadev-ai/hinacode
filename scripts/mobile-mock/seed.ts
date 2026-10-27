// Copies the real HinaCode database into a stopped cloud's profile with personal data scrubbed, so the phone app
// can be tested against real-shaped threads. Only the public `hinacode` project keeps its transcripts.
// Usage: node scripts/mobile-mock/seed.ts <user-data-dir> [source.sqlite]   (launch.sh next to this file runs it)
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, extname, join, resolve } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

type Row = Record<string, SQLInputValue | undefined>
type Rule = readonly [RegExp | string, string | ((match: string, ...groups: Array<string>) => string)]

const data = process.argv[2] ? resolve(process.argv[2]) : undefined
if (!data) throw new Error("Usage: node scripts/mobile-mock/seed.ts <user-data-dir> [source.sqlite]")
if (data.startsWith(homedir()))
  throw new Error("Keep the profile outside your home directory; its paths would read as leaks")
const profile = join(
  process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config"),
  "kkcode",
)
const source = new DatabaseSync(process.argv[3] ?? join(profile, "hinacode.sqlite"), { readOnly: true })
const target = new DatabaseSync(join(data, "hinacode.sqlite"))
const repo = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
}).trim()
const PUBLIC_PROJECT = "hinacode"
const PUBLIC_PULL_REQUESTS = "https://github.com/hinadev-ai/hinacode/pull/"

const rows = (sql: string, ...params: Array<SQLInputValue>) => source.prepare(sql).all(...params) as Array<Row>
const setting = (key: string) => {
  const row = source.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined
  return row === undefined ? undefined : (JSON.parse(row.value) as unknown)
}

const projects = rows("SELECT * FROM project")
const publicProject = projects.find((project) => project.name === PUBLIC_PROJECT && project.kind === "folder")
const chatsSourceId = projects.find((project) => project.kind === "chats")?.id
const chats = target.prepare("SELECT id, root_path FROM project WHERE kind = 'chats'").get() as Row | undefined
if (chats === undefined) throw new Error(`${data} has no Chats project; boot the cloud once before seeding`)

const mockRoot = (project: Row, index: number) =>
  project.kind === "chats"
    ? String(chats.root_path)
    : join(data, "repos", project === publicProject ? PUBLIC_PROJECT : `example-${index + 1}`)
const realWorktreeRoot = setting("worktreeRoot")
const paths: Array<readonly [string, string]> = [
  ...projects.map((project, index) => [String(project.root_path), mockRoot(project, index)] as const),
  ...(typeof realWorktreeRoot === "string" ? [[realWorktreeRoot, join(data, "worktrees")] as const] : []),
]

const entropy = (text: string) => {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  return [...counts.values()].reduce((sum, count) => sum - (count / text.length) * Math.log2(count / text.length), 0)
}
const privateIps = new Map<string, string>()
const user = userInfo().username

// Specific credentials first, then identities, then anything that merely looks random.
const rules: ReadonlyArray<Rule> = [
  ...paths,
  [/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, "data:image/png;base64,"],
  [/\beyJ[\w-]+\.[\w-]+(\.[\w-]+)?/g, "[redacted-jwt]"],
  [
    /\b(gh[pousr]_\w{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abpr]-[\w-]+|lin_(api|oauth)_\w+|AKIA[0-9A-Z]{16})/g,
    "[redacted-key]",
  ],
  // A value with a digit, or any password, so code such as `token: string` keeps reading as code.
  [
    /((token|secret|password|passwd|api[_-]?key|credential)["']?\s*[:=]\s*["']?)([^\s"'&,`\\]{6,})/gi,
    (match, prefix, key, value) => (/\d/.test(value) || /pass/i.test(key) ? `${prefix}[redacted]` : match),
  ],
  [/\b(?!git@)[\w.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "dev@example.com"],
  [/\b[\w-]+\.[\w-]+\.ts\.net\b/g, "devbox.tail0000.ts.net"],
  [/\b[0-9a-f]{16}\.hinacode\.app\b/g, "0000000000000000.hinacode.app"],
  [
    /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
    (ip) => privateIps.get(ip) ?? (privateIps.set(ip, `192.0.2.${privateIps.size + 1}`), privateIps.get(ip)!),
  ],
  [new RegExp(`/(Users|Volumes|home)/${user}\\b`, "gi"), "/Users/dev"],
  [new RegExp(user, "gi"), "dev"],
  [/kjj6198/gi, "dev"],
  [/voichu/gi, "widget"],
  [/amuai/gi, "acme"],
  [/\b[0-9a-f]{48,}\b/g, "[redacted-hex]"],
  [/[A-Za-z0-9+_=-]{32,}/g, (run) => (entropy(run) > 4.3 ? "[redacted]" : run)],
]

const scrub = (text: string) =>
  rules.reduce((out, [pattern, replace]) => out.replaceAll(pattern, replace as string), text)
const scrubJson = (value: unknown): unknown =>
  typeof value === "string"
    ? scrub(value)
    : Array.isArray(value)
      ? value.map(scrubJson)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrubJson(inner)]))
        : value
const scrubColumn = (value: SQLInputValue | undefined) =>
  typeof value === "string" ? JSON.stringify(scrubJson(JSON.parse(value))) : (value ?? null)

const placeholderIcon = join(import.meta.dirname, "..", "..", "assets", "icon.png")
type Attachment = { id: string; name: string; path: string; kind: "image" | "file" }
// The real files are screenshots and dumps of the user's screen, so every attachment points at a stand-in.
const stageAttachment = (attachment: Attachment) => {
  const path = join(data, "attachments", `${attachment.id}${extname(attachment.name) || ".txt"}`)
  if (attachment.kind === "image") copyFileSync(placeholderIcon, path)
  else writeFileSync(path, `Placeholder for ${attachment.name}\n`)
  return { ...attachment, path }
}
const withStagedAttachments = (parts: Array<Record<string, unknown>>) =>
  parts.map((part) =>
    part.type === "attachment" ? { ...part, attachment: stageAttachment(part.attachment as Attachment) } : part,
  )

const insert = (table: string, row: Row) => {
  const keys = Object.keys(row)
  target
    .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...Object.values(row).map((value) => value ?? null))
}
const pick = (row: Row, keys: ReadonlyArray<string>) => Object.fromEntries(keys.map((key) => [key, row[key]]))

const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" })
const cloneDir = join(data, "repos", PUBLIC_PROJECT)
const prepareRepos = () => {
  mkdirSync(join(data, "repos"), { recursive: true })
  execFileSync("git", ["clone", "-q", "--local", "--single-branch", "--branch", "main", repo, cloneDir])
  git(cloneDir, "remote", "set-url", "origin", "https://github.com/hinadev-ai/hinacode.git")
  projects.forEach((project, index) => {
    if (project === publicProject || project.kind === "chats") return
    const root = mockRoot(project, index)
    mkdirSync(root, { recursive: true })
    git(root, "init", "-q", "-b", "main")
    writeFileSync(join(root, "README.md"), `# ${basename(root)}\n`)
    git(root, "add", "README.md")
    git(root, "-c", "user.name=mobile-mock", "-c", "user.email=dev@example.com", "commit", "-qm", "chore: seed")
  })
}

const isPublic = (projectId: SQLInputValue | undefined) => projectId === publicProject?.id
const threads = rows("SELECT * FROM thread")
const liveWorktrees = new Set(
  threads.filter((thread) => isPublic(thread.project_id) && thread.status !== "archived").map((t) => t.worktree_id),
)

const seedProjects = () =>
  projects.forEach((project, index) => {
    if (project.kind === "chats") return
    insert("project", {
      ...pick(project, ["id", "created_at", "updated_at", "linear_review", "kind"]),
      name: project === publicProject ? PUBLIC_PROJECT : `example-${index + 1}`,
      root_path: mockRoot(project, index),
      setup_script: null,
    })
  })

const seedWorktrees = () =>
  rows("SELECT * FROM worktree").forEach((worktree) => {
    const path = scrub(String(worktree.path))
    const live = worktree.status === "ready" && liveWorktrees.has(worktree.id)
    if (live) {
      mkdirSync(join(path, ".."), { recursive: true })
      try {
        git(cloneDir, "worktree", "add", "-q", "-B", String(worktree.branch), path)
      } catch {
        git(cloneDir, "worktree", "add", "-q", "--detach", path)
      }
    }
    insert("worktree", {
      ...pick(worktree, ["id", "project_id", "branch", "base_ref", "created_at"]),
      path,
      status: live ? "ready" : "removed",
      setup_log: scrub(String(worktree.setup_log)),
    })
  })

const seedAccounts = () =>
  rows("SELECT * FROM agent_account ORDER BY created_at").forEach((account, index) => {
    const configDir = join(data, "accounts", String(account.id))
    mkdirSync(configDir, { recursive: true })
    insert("agent_account", {
      ...pick(account, ["id", "provider", "created_at"]),
      name: `Account ${index + 1}`,
      config_dir: configDir,
      binary: "",
    })
  })

const seedThreads = () =>
  threads.forEach((thread) => {
    const queue = (scrubJson(JSON.parse(String(thread.queue))) as Array<{ attachments: Array<Attachment> }>).map(
      (queued) => ({ ...queued, attachments: queued.attachments.map(stageAttachment) }),
    )
    insert("thread", {
      ...pick(thread, [
        "id",
        "worktree_id",
        "model",
        "sort_index",
        "created_at",
        "updated_at",
        "created_by",
        "effort",
        "fast_mode",
        "access_mode",
        "status",
        "account_id",
        "provider",
        "pinned_at",
        "user_skills",
        "snoozed_until",
      ]),
      project_id: thread.project_id === chatsSourceId ? String(chats.id) : thread.project_id,
      title: isPublic(thread.project_id) ? scrub(String(thread.title)) : `thread-${String(thread.id).slice(0, 5)}`,
      usage_limit: scrubColumn(thread.usage_limit),
      queue: JSON.stringify(queue),
    })
  })

const seedMessages = () =>
  rows(
    "SELECT message.* FROM message JOIN thread ON thread.id = message.thread_id WHERE thread.project_id = ?",
    publicProject?.id ?? null,
  ).forEach((message) =>
    insert("message", {
      ...pick(message, ["id", "thread_id", "role", "created_at", "completed_at", "usage"]),
      parts: JSON.stringify(
        withStagedAttachments(scrubJson(JSON.parse(String(message.parts))) as Array<Record<string, unknown>>),
      ),
    }),
  )

const seedPullRequests = () => {
  rows("SELECT * FROM pull_request_link WHERE url LIKE ?", `${PUBLIC_PULL_REQUESTS}%`).forEach((link) =>
    insert("pull_request_link", pick(link, ["id", "thread_id", "url", "created_at"])),
  )
  rows("SELECT * FROM pull_request_guide WHERE url LIKE ?", `${PUBLIC_PULL_REQUESTS}%`).forEach((guide) =>
    insert("pull_request_guide", { url: guide.url, guide: scrubColumn(guide.guide) }),
  )
}

const KEPT_SETTINGS = [
  "appearance",
  "archive",
  "defaultAccessMode",
  "defaultAccount",
  "defaultEffort",
  "defaultFastMode",
  "defaultModel",
  "defaultProvider",
  "defaultWorkspaceMode",
  "keybindings",
  "locale",
  "modelPresets",
  "pullRequestGuide",
]
const seedSettings = (remotePort: number) => {
  const upsert = target.prepare(
    "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
  for (const key of KEPT_SETTINGS) {
    const value = setting(key)
    if (value !== undefined) upsert.run(key, JSON.stringify(value))
  }
  upsert.run("worktreeRoot", JSON.stringify(join(data, "worktrees")))
  upsert.run("automations", JSON.stringify({ bindHost: "127.0.0.1", port: remotePort + 1 }))
}

const hours = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString()

// The real database rarely holds these at rest, so two idle threads carry them.
const seedMissingStates = () => {
  const idle = target
    .prepare("SELECT id FROM thread WHERE status = 'idle' AND project_id = ? ORDER BY updated_at DESC LIMIT 3")
    .all(publicProject?.id ?? null) as Array<{ id: string }>
  const update = (sql: string, ...params: Array<SQLInputValue>) => target.prepare(sql).run(...params)
  if (idle[0]) {
    const queue = [
      { id: randomUUID(), text: "Also run the e2e suite once this passes", attachments: [] },
      { id: randomUUID(), text: "Then open a PR", attachments: [] },
    ]
    update("UPDATE thread SET queue = ? WHERE id = ?", JSON.stringify(queue), idle[0].id)
  }
  if (idle[1]) update("UPDATE thread SET snoozed_until = ? WHERE id = ?", hours(3), idle[1].id)
  if (idle[2]) update("UPDATE thread SET snoozed_until = ? WHERE id = ?", hours(-1), idle[2].id)
}

// Strings that identify this machine or its user. None may survive the scrub.
const assertNoLeaks = () => {
  const known = [
    homedir(),
    user,
    ...projects.map((project) => String(project.root_path)),
    ...rows("SELECT host FROM environment").map((environment) => String(environment.host)),
    (setting("relay.tunnel") as { hostname?: string } | undefined)?.hostname,
    spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout.trim(),
  ].filter((value): value is string => typeof value === "string" && value.length > 2)
  const tables = [
    "project",
    "thread",
    "worktree",
    "message",
    "pull_request_link",
    "pull_request_guide",
    "agent_account",
    "setting",
  ]
  for (const table of tables) {
    const dump = JSON.stringify(target.prepare(`SELECT * FROM ${table}`).all()).toLowerCase()
    const leak = known.find((value) => dump.includes(value.toLowerCase()))
    if (leak !== undefined) throw new Error(`${table} still contains ${JSON.stringify(leak)}`)
  }
}

const remote = target.prepare("SELECT value FROM setting WHERE key = 'remote'").get() as { value: string } | undefined
mkdirSync(join(data, "attachments"), { recursive: true })
prepareRepos()
target.exec("BEGIN")
seedProjects()
seedWorktrees()
seedAccounts()
seedThreads()
seedMessages()
seedPullRequests()
seedSettings(remote === undefined ? 48091 : (JSON.parse(remote.value) as { port: number }).port)
seedMissingStates()
target.exec("COMMIT")
assertNoLeaks()
const count = (table: string) => (target.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
console.log(
  `seeded ${data}: ${count("project")} projects, ${count("thread")} threads, ${count("message")} messages, ${count("pull_request_link")} pull requests`,
)
