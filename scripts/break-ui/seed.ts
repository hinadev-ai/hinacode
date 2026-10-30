import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

type Row = Record<string, SQLInputValue | object>
type Project = { id: string; name: string; root_path: string }

const data = process.argv[2]
if (!data) throw new Error("Usage: node scripts/break-ui/seed.ts <user-data-dir>")
const db = new DatabaseSync(join(data, "hinacode.sqlite"))

let clock = Date.parse("2026-10-17T05:00:00Z")
const at = () => new Date((clock += 1000)).toISOString()
const insert = (table: string, row: Row) => {
  const keys = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(
    ...Object.values(row).map((value) => (value !== null && typeof value === "object" ? JSON.stringify(value) : value)),
  )
}

const worktree = (project: Project, branch: string) => {
  const id = randomUUID()
  insert("worktree", {
    id,
    project_id: project.id,
    path: `${project.root_path}/.worktrees/${branch.replaceAll("/", "-")}`,
    branch,
    base_ref: "origin/main",
    status: "ready",
    setup_log: "",
    created_at: at(),
  })
  return id
}

let sort = 0
const thread = (project: Project, title: string, extra: Row = {}) => {
  const id = randomUUID()
  insert("thread", {
    id,
    project_id: project.id,
    worktree_id: null,
    title,
    model: "claude-sonnet-5-5",
    provider: "claude",
    status: "idle",
    sort_index: sort++,
    created_at: at(),
    updated_at: at(),
    ...extra,
  })
  return id
}

const message = (threadId: string, role: string, parts: object[], usage: object | null = null) =>
  insert("message", {
    id: randomUUID(),
    thread_id: threadId,
    role,
    parts,
    created_at: at(),
    completed_at: at(),
    usage,
  })

const call = (name: string, input: object, output: string | undefined, status = "done") => ({
  type: "tool_call",
  callId: randomUUID(),
  name,
  input,
  output,
  status,
})

const project = (name: string): Project => {
  const rootPath = join(data, "repos", name)
  mkdirSync(rootPath, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-C", rootPath, ...args])
  git("init", "-q", "-b", "main")
  writeFileSync(join(rootPath, "README.md"), `# ${name}\n`)
  git("add", "README.md")
  git("-c", "user.name=break-ui", "-c", "user.email=break-ui@localhost", "commit", "-qm", "chore: seed")
  const row = { id: randomUUID(), name, root_path: rootPath, created_at: at(), updated_at: at() }
  insert("project", row)
  return row
}

const long = project("northwind-industries-customer-onboarding-platform-monorepo")
project("x")
const jp = project("ヒナコード社内ツール-デスクトップ版")
const demo = project("demo")

const branch = "feat/investigate-onboarding-webhook-retries-stripe-409-conflict-duplicate-customers-eu-region"
const t1 = thread(
  long,
  "Investigate why the onboarding webhook retries forever when Stripe returns a 409 conflict for duplicate customers in the EU region",
  { worktree_id: worktree(long, branch), status: "running", pinned_at: at(), effort: "xhigh", fast_mode: 1 },
)
message(t1, "user", [
  {
    type: "text",
    text: [
      "Aleksandra Wiśniewska-Kowalczyk reported this, cc bartholomew.fitzgerald@northwind-industries-holdings.example.com.",
      "Logs: https://dash.cloudflare.com/e71bb8465534552f8ddc37c7962f98ae/workers/services/view/hinacode-site/production/builds/c00e9803-53d7-4d80-845c-bbdde9727f12",
      "Sentry: https://northwind-industries.sentry.io/issues/4823749283/events/a1b2c3d4e5f60718293a4b5c6d7e8f90/?project=4504829384729384&query=is%3Aunresolved",
      "Stack: OnboardingWebhookRetryPolicyWithExponentialBackoffAndJitter.handleDuplicateCustomerConflictResponse",
      "東京リージョンでも同じ現象が起きています。重複した顧客を作成しようとすると、Webhookが永遠に再試行され続けるので、キューが詰まってしまいます。",
    ].join("\n"),
  },
  {
    type: "attachment",
    attachment: {
      id: randomUUID(),
      name: "Screenshot 2026-10-17 at 14.03.27 - Stripe dashboard showing 409 conflict on customer create (EU).png",
      path: join(data, "attachments", "missing.png"),
      mime: "image/png",
      kind: "image",
      bytes: 48_213_904,
    },
  },
  {
    type: "attachment",
    attachment: {
      id: randomUUID(),
      name: "onboarding-webhook-retry-queue-dump-eu-west-1-2026-10-17T05-00-00Z.ndjson",
      path: join(data, "attachments", "dump.ndjson"),
      mime: "application/x-ndjson",
      kind: "file",
      bytes: 1_284_000_000,
    },
  },
])
const deepPath =
  "src/main/services/automations/pollers/github/OnboardingWebhookRetryPolicyWithExponentialBackoffAndJitter.integration.test.ts"
message(
  t1,
  "assistant",
  [
    { type: "reasoning", text: "The retry policy treats 409 as retryable. ".repeat(40) },
    call(
      "Bash",
      {
        command:
          "pnpm --filter @northwind/onboarding-webhooks exec vitest run src/services/OnboardingWebhookRetryPolicyWithExponentialBackoffAndJitter.integration.test.ts --reporter=verbose --testNamePattern='handles 409 duplicate customer conflict without retrying forever'",
        description: "Run the retry policy integration test",
      },
      "\x1b[1m\x1b[31m FAIL \x1b[39m\x1b[22m src/services/OnboardingWebhookRetryPolicyWithExponentialBackoffAndJitter.integration.test.ts\n\x1b[31mAssertionError: expected 1284 retries to be at most 5\x1b[39m\n\x1b[2m at /home/aleksandra/code/northwind-industries-customer-onboarding-platform-monorepo/packages/onboarding-webhooks/src/services/retry.ts:128:17\x1b[22m\n" +
        "e71bb8465534552f8ddc37c7962f98aee71bb8465534552f8ddc37c7962f98aee71bb8465534552f8ddc37c7962f98ae",
      "error",
    ),
    { type: "text", text: "Next I'll read the policy and the test." },
    call(
      "Read",
      { file_path: `/home/aleksandra/code/${long.name}/${deepPath}` },
      "1\timport { describe } from 'vitest'",
    ),
    call(
      "Grep",
      { pattern: "isRetryableStatus\\(response\\.status\\)\\s*&&\\s*attempt\\s*<\\s*MAX_ATTEMPTS" },
      "retry.ts:128",
    ),
    call("Bash", { command: "git log --oneline -n 1284" }, "a".repeat(40) + " fix"),
    call("mcp__hinacode__review_changes", { scope: "worktree" }, "ok"),
    call(
      "WebFetch",
      { url: "https://docs.stripe.com/api/errors/handling?lang=node#idempotency-and-conflict-errors-for-customers" },
      "ok",
    ),
    call("Bash", { command: "sleep 600" }, undefined, "running"),
    {
      type: "file_change",
      path: `packages/onboarding-webhooks/${deepPath}`,
      diff: "--- a\n+++ b\n@@ -1 +1 @@\n-retry\n+do not retry 409\n",
    },
    {
      type: "text",
      text: [
        "## Root cause: `isRetryableStatus()` in `OnboardingWebhookRetryPolicyWithExponentialBackoffAndJitter` treats 409 as transient",
        "",
        `The check lives in \`${deepPath}\` and in \`https://github.com/northwind-industries/customer-onboarding-platform-monorepo/blob/main/packages/onboarding-webhooks/src/services/retry.ts#L128\`.`,
        "",
        "| Status | Retryable before | Retryable after | Notes about this status code that are fairly long |",
        "| --- | --- | --- | --- |",
        "| 409 | yes | no | Stripe returns this for duplicate customers with an idempotency key reused across regions |",
        "| 429 | yes | yes | Rate limited |",
        "",
        "```ts",
        "if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS && !isDuplicateCustomerConflict(response.body.error.code)) { return scheduleRetry(attempt + 1) }",
        "```",
        "",
        "1. 重複した顧客の409は再試行しないように修正しました。",
        "2. Added a regression test.",
      ].join("\n"),
    },
  ],
  {
    inputTokens: 128_449_302,
    outputTokens: 9_847_221,
    costUsd: 1284.567891,
    context: { usedTokens: 987_654, maxTokens: 1_000_000 },
  },
)
insert("pull_request_link", {
  id: randomUUID(),
  thread_id: t1,
  url: "https://github.com/hinadev-ai/hinacode/pull/12845",
  created_at: at(),
})
insert("pull_request_link", {
  id: randomUUID(),
  thread_id: t1,
  url: "https://github.com/northwind-industries-holdings/customer-onboarding-platform-monorepo/pull/1",
  created_at: at(),
})
db.prepare("UPDATE thread SET queue = ? WHERE id = ?").run(
  JSON.stringify([
    {
      id: randomUUID(),
      text: "Also check https://northwind-industries.sentry.io/issues/4823749283/events/a1b2c3d4e5f60718293a4b5c6d7e8f90/?project=4504829384729384 and the EU region config",
      attachments: [],
    },
    { id: randomUUID(), text: "ok", attachments: [] },
  ]),
  t1,
)

const jo = thread(long, "Jo", { provider: "codex", model: "gpt-5.5-codex", status: "awaiting_approval" })
message(jo, "user", [{ type: "text", text: "a" }])
message(jo, "assistant", [
  {
    type: "questions",
    text: "",
    questions: [
      {
        id: "q1",
        header: "Conflict handling strategy for duplicate customers",
        question:
          "Stripe returns 409 for duplicate customers. Should the webhook skip the event, merge into the existing customer, or page the on-call engineer through PagerDuty?",
        options: [
          {
            label: "Skip the event and mark the delivery as handled without notifying anyone",
            description:
              "Fastest, but silently drops data when the duplicate is a genuine new signup from the same email",
          },
          { label: "Merge", description: "" },
          { label: "Page on-call", description: "Wakes someone up at 3am" },
        ],
        multiSelect: true,
        allowsText: true,
        secret: false,
      },
    ],
  },
])
thread(
  long,
  "東京リージョンの顧客オンボーディングでWebhookが無限に再試行される問題を調査して修正し、回帰テストを追加する",
  {
    status: "limited",
    usage_limit: {
      kind: "usage",
      message:
        "You've hit your weekly limit for Claude Opus 5.5 across all of your organization's seats. Your limit resets Tuesday at 9:00 AM in your local time zone; extra usage is disabled by your organization's administrator.",
      reset: { at: "2026-10-20T00:00:00Z", autoResume: true },
    },
  },
)
thread(long, "🚀🔥 Ship it", { provider: "muse", model: "muse-1" })
thread(
  long,
  "Fix crash in src/renderer/components/sidePanel/ChangesViewWithVirtualizedDiffRendererAndStickyHeaders.tsx",
  {
    created_by: "automation:x",
  },
)
thread(long, "مرحبا بالعالم: إصلاح خطأ في واجهة المستخدم")

const hina = project("hinacode")
const relay = thread(hina, "Relay server e2e encryption", { pinned_at: at() })
message(relay, "user", [{ type: "text", text: "Is our relay server end-to-end encrypted?" }])
message(relay, "assistant", [
  { type: "reasoning", text: "I should check the relay worker, the handshake, and the ADRs about Cloudflare." },
  call("Grep", { pattern: "x25519|chacha|aes-gcm", path: "src" }, "No matches found"),
  call(
    "Read",
    { file_path: "docs/adr/0020-cloudflare-tunnel-as-the-relay.md" },
    "1\t# 20. Cloudflare Tunnel as the relay\n2\t\n3\tCloudflare terminates TLS and can read frames in transit.",
  ),
  {
    type: "text",
    text: [
      "No. Today it is TLS to the Cloudflare edge, and Cloudflare decrypts TLS there, so it can read frames in transit.",
      "",
      "### Where things stand",
      "",
      "- **Through the relay:** the client connects to `wss://<hostname>/remote`, and Cloudflare Tunnel forwards to `cloudflared` on the machine. ADR `0020-cloudflare-tunnel-as-the-relay.md` says so outright.",
      "- **The relay service itself** (Worker + D1) never touches frames. It only hands out hostnames and connector tokens.",
      "- **The pairing token is never in a frame.** The server sends a nonce and the client proves it holds the token with HMAC-SHA256 (ADR 0022).",
      "- **Direct connections** (LAN, Tailscale) use plain `ws://`. Tailscale adds WireGuard; an ordinary LAN does not.",
      "",
      "| Path | Encrypted to | Who can read frames |",
      "| --- | --- | --- |",
      "| Relay | Cloudflare edge | Cloudflare |",
      "| Tailscale | Peer | Nobody else |",
      "| LAN | Nothing | Anyone on the network |",
    ].join("\n"),
  },
])
message(relay, "user", [{ type: "text", text: "Implement e2e encryption for both paths." }])
const explore = randomUUID()
message(relay, "assistant", [
  {
    type: "tool_call",
    callId: explore,
    name: "Agent",
    input: {
      description: "Map the remote handshake",
      prompt: "Find every place the remote protocol sends or reads a frame, and where the pairing token is checked.",
    },
    output: "Frames go through `src/main/remote/socket.ts`; the token check is `verifyProof` in `handshake.ts`.",
    status: "done",
  },
  {
    ...call("Grep", { pattern: "send\\(|onmessage", path: "src/main/remote" }, "socket.ts:42\nsocket.ts:88"),
    parentCallId: explore,
  },
  {
    ...call("Read", { file_path: "src/main/remote/handshake.ts" }, "1\texport function verifyProof("),
    parentCallId: explore,
  },
  call("Read", { file_path: "src/shared/handshake.ts" }, "1\texport const PROTOCOL_VERSION = 1"),
  call(
    "Edit",
    { file_path: "src/shared/handshake.ts", old_string: "PROTOCOL_VERSION = 1", new_string: "PROTOCOL_VERSION = 2" },
    "The file src/shared/handshake.ts has been updated.",
  ),
  {
    type: "file_change",
    path: "src/shared/handshake.ts",
    diff: [
      "--- a/src/shared/handshake.ts",
      "+++ b/src/shared/handshake.ts",
      "@@ -1,3 +1,8 @@",
      "-export const PROTOCOL_VERSION = 1",
      '+import { x25519 } from "@noble/curves/ed25519"',
      '+import { chacha20poly1305 } from "@noble/ciphers/chacha"',
      "+",
      "+export const PROTOCOL_VERSION = 2",
      "+",
      "+export const keyPair = () => x25519.keygen()",
      "",
    ].join("\n"),
  },
  call(
    "Bash",
    { command: "pnpm test src/shared/handshake.test.ts", description: "Run the handshake tests" },
    "\x1b[32m✓\x1b[39m src/shared/handshake.test.ts (6 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)",
  ),
  {
    type: "text",
    text: [
      "Relay and direct connections are both end-to-end encrypted now.",
      "",
      "### What changed",
      "",
      "1. Each socket makes a one-time **X25519** key pair, and the public key goes into the existing HMAC proof.",
      "2. Both directions derive a key with HKDF, salted with the pairing token.",
      "3. Every frame after `ready` is binary **ChaCha20-Poly1305**, with the frame counter as the nonce.",
      "",
      "```ts",
      "const shared = x25519.getSharedSecret(ours.secretKey, theirs)",
      'const key = hkdf(sha256, shared, pairingToken, "hinacode/remote/v2", 32)',
      "const sealed = chacha20poly1305(key, nonce(counter++)).encrypt(frame)",
      "```",
      "",
      "> Pairing URLs, QR codes and relay sign-in are unchanged, so paired devices do not need to pair again.",
      "",
      "The protocol version is now 2. A v1 client gets a clear *update required* error instead of a silent failure.",
    ].join("\n"),
  },
])

thread(jp, "a")
for (let i = 1; i <= 300; i++) thread(demo, `Thread ${i}: refactor module ${i}`)

const automation = randomUUID()
insert("automation", {
  id: automation,
  project_id: long.id,
  name: "Triage every new GitHub issue labelled bug or regression in the customer onboarding platform monorepo",
  enabled: 1,
  trigger: {
    type: "github.issue",
    repo: "northwind-industries-holdings/customer-onboarding-platform-monorepo",
    labels: ["bug", "regression", "needs-triage", "priority:p0-critical-customer-impact", "area:onboarding-webhooks"],
  },
  prompt_template: "Investigate {{issue.title}} ".repeat(30),
  model: "claude-sonnet-5-5",
  provider: "claude",
  run_in_worktree: 1,
  branch_template: "fix/{{issue.number}}-{{issue.title}}",
  created_at: at(),
  updated_at: at(),
})
insert("automation_run", {
  id: randomUUID(),
  automation_id: automation,
  thread_id: null,
  event_key: "northwind-industries-holdings/customer-onboarding-platform-monorepo#128449",
  payload: {},
  status: "failed",
  error:
    "gh: GraphQL: Could not resolve to a Repository with the name 'northwind-industries-holdings/customer-onboarding-platform-monorepo'. (repository)\nHTTP 404: Not Found (https://api.github.com/graphql)",
  created_at: at(),
})
insert("automation", {
  id: randomUUID(),
  project_id: demo.id,
  name: "a",
  enabled: 0,
  trigger: { type: "webhook" },
  prompt_template: "{{body}}",
  model: "m",
  provider: "codex",
  run_in_worktree: 0,
  created_at: at(),
  updated_at: at(),
})

insert("agent_account", {
  id: randomUUID(),
  provider: "claude",
  name: "Aleksandra Wiśniewska-Kowalczyk (Northwind Industries Holdings, Enterprise seat)",
  created_at: at(),
  config_dir: "/home/aleksandra/.config/hinacode/accounts/claude-northwind-industries-holdings-enterprise",
  binary: "",
})
insert("agent_account", {
  id: randomUUID(),
  provider: "codex",
  name: "Jo",
  created_at: at(),
  config_dir: "",
  binary: "",
})
insert("environment", {
  id: randomUUID(),
  name: "Northwind build box in eu-west-1 (shared with the onboarding team)",
  host: "ip-10-128-44-201.eu-west-1.compute.internal.northwind-industries-holdings.example.com",
  port: 65535,
  created_at: at(),
})
mkdirSync(join(data, "attachments"), { recursive: true })
writeFileSync(join(data, "attachments", "dump.ndjson"), "{}\n")
console.log(`seeded ${data}`)
