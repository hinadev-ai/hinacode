import type { AgentEvent, Question } from "../../../../shared/agent.ts"

export type DemoStep =
  | { readonly kind: "event"; readonly event: AgentEvent; readonly pauseMs: number }
  | { readonly kind: "approval"; readonly title: string; readonly command: string }
  | { readonly kind: "question"; readonly question: Question }

const say = (text: string): Array<DemoStep> =>
  (text.match(/\S+\s*/g) ?? []).map((word) => ({
    kind: "event",
    event: { type: "text_delta", text: word },
    pauseMs: 35,
  }))

const think = (text: string): Array<DemoStep> =>
  (text.match(/\S+\s*/g) ?? []).map((word) => ({
    kind: "event",
    event: { type: "reasoning_delta", text: word },
    pauseMs: 25,
  }))

let calls = 0
const tool = (name: string, input: unknown, output: string, runMs = 700): Array<DemoStep> => {
  const callId = `demo-${name.toLowerCase()}-${++calls}`
  return [
    { kind: "event", event: { type: "tool_call_started", callId, name, input }, pauseMs: runMs },
    { kind: "event", event: { type: "tool_call_finished", callId, output, isError: false }, pauseMs: 250 },
  ]
}

const done: DemoStep = { kind: "event", event: { type: "turn_completed" }, pauseMs: 0 }

const loginSpec = `import { expect, test } from "@playwright/test"

test("signs in with email", async ({ page }) => {
  await page.goto("/login")
  await page.getByLabel("Email").fill("ada@example.com")
  await page.getByLabel("Password").fill("correct horse")
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForTimeout(500)
  await expect(page).toHaveURL("/dashboard")
})
`

const flakyLogin = (): Array<DemoStep> => [
  ...think(
    "A test that fails one run in five is usually waiting on time instead of state. Start with the spec and look for fixed sleeps.",
  ),
  ...tool("Read", { file_path: "e2e/login.spec.ts" }, loginSpec),
  ...tool("Grep", { pattern: "waitForTimeout", path: "e2e" }, "e2e/login.spec.ts:8:  await page.waitForTimeout(500)"),
  ...say(
    "The test waits a fixed 500 ms after signing in. On a slow CI runner the redirect takes longer than that, so the URL check runs too early. I'll wait for the dashboard heading instead of the clock.\n\n",
  ),
  ...tool(
    "Edit",
    {
      file_path: "e2e/login.spec.ts",
      old_string: '  await page.waitForTimeout(500)\n  await expect(page).toHaveURL("/dashboard")',
      new_string:
        '  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()\n  await expect(page).toHaveURL("/dashboard")',
    },
    "The file e2e/login.spec.ts has been updated.",
  ),
  { kind: "approval", title: "Run the login test 20 times", command: "pnpm test:e2e login.spec.ts --repeat-each 20" },
  ...tool(
    "Bash",
    { command: "pnpm test:e2e login.spec.ts --repeat-each 20", description: "Run the login test 20 times" },
    "Running 20 tests using 4 workers\n\n  20 passed (41.2s)",
    2400,
  ),
  {
    kind: "question",
    question: {
      id: "pull-request",
      header: "Pull request",
      question: "All 20 runs pass. How should I open the pull request?",
      options: [
        { label: "Ready for review", description: "Request review from the web team" },
        { label: "Draft", description: "Keep it as a draft until CI passes" },
      ],
      multiSelect: false,
      allowsText: true,
      secret: false,
    },
  },
  ...tool(
    "Bash",
    { command: "git push -u origin fix/flaky-login", description: "Push the branch" },
    "branch 'fix/flaky-login' set up to track 'origin/fix/flaky-login'.",
    900,
  ),
  ...say(
    "Pushed `fix/flaky-login`. The login test now waits for the dashboard instead of a timer, and it passed 20 runs in a row.\n\n- **Cause:** a fixed 500 ms sleep raced the redirect on slow runners.\n- **Fix:** wait for the dashboard heading, then check the URL.\n",
  ),
  done,
]

const csvExport = (): Array<DemoStep> => [
  ...tool("Read", { file_path: "src/routes/reports.ts" }, 'export const reports = new Hono().get("/", listReports)'),
  ...say("Reports already stream as JSON. I'll add a `format` parameter and reuse the same query.\n\n"),
  ...tool(
    "Write",
    {
      file_path: "src/csv.ts",
      content:
        'export const toCsv = (rows: ReadonlyArray<Record<string, unknown>>) =>\n  rows.map((row) => Object.values(row).map(quote).join(",")).join("\\n")\n',
    },
    "File created successfully at: src/csv.ts",
  ),
  ...tool(
    "Edit",
    {
      file_path: "src/routes/reports.ts",
      old_string: 'export const reports = new Hono().get("/", listReports)',
      new_string: 'export const reports = new Hono().get("/", listReports).get("/export.csv", exportReports)',
    },
    "The file src/routes/reports.ts has been updated.",
  ),
  ...tool("Bash", { command: "pnpm test reports", description: "Run the report tests" }, "14 passed (1.3s)", 1600),
  ...say("Done. `GET /reports/export.csv` downloads the report, and the tests cover quoting and empty reports.\n"),
  done,
]

const viteUpgrade = (): Array<DemoStep> => [
  ...tool(
    "Edit",
    { file_path: "package.json", old_string: '"vite": "7.3.7"', new_string: '"vite": "8.0.2"' },
    "The file package.json has been updated.",
  ),
  ...tool("Bash", { command: "pnpm install && pnpm build", description: "Build with Vite 8" }, "built in 2.84s", 1400),
  ...say("Upgraded to Vite 8. The build passes locally and the bundle is 4% smaller.\n"),
  done,
]

const translation = (): Array<DemoStep> => [
  ...tool("Read", { file_path: "messages/en.json" }, '{ "settings_title": "Settings", ... }'),
  ...tool(
    "Edit",
    { file_path: "messages/ja.json", old_string: "{", new_string: '{\n  "settings_title": "設定",' },
    "The file messages/ja.json has been updated.",
  ),
  ...tool("Bash", { command: "pnpm test messages", description: "Check the catalogs" }, "4 passed (0.2s)", 900),
  ...say("Added 48 Japanese strings for the settings page. The catalog test passes.\n"),
  done,
]

const fallback = (): Array<DemoStep> => [
  ...say("Done. I read the change, ran the tests, and everything passes.\n"),
  done,
]

export const demoTurn = (prompt: string): Array<DemoStep> => {
  const text = prompt.toLowerCase()
  if (text.includes("login")) return flakyLogin()
  if (text.includes("csv")) return csvExport()
  if (text.includes("vite")) return viteUpgrade()
  if (text.includes("japanese")) return translation()
  return fallback()
}
