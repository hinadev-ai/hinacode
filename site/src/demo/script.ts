import { fill } from "../fill.ts"
import type { DemoCopy } from "./copy.ts"
import type { Step, ThreadSeed } from "./engine.ts"

const allowed = (flags: { decision?: string }) => flags.decision !== "deny"
const denied = (flags: { decision?: string }) => flags.decision === "deny"

const prompt = (text: string): Step => ({ do: "user", text })

export function seeds(copy: DemoCopy): ThreadSeed[] {
  const replyTo = { followup: copy.site_demo_followup_reply, steer: copy.site_demo_steer_reply }

  const flakyLogin: ThreadSeed = {
    id: "flaky-login",
    title: copy.site_demo_t1_title,
    project: "web",
    branch: "fix/flaky-login",
    provider: "claude",
    ports: [],
    replyTo,
    prefill: [prompt(copy.site_demo_t1_prompt)],
    steps: [
      { do: "tool", tool: "read", target: "e2e/login.spec.ts", ms: 700, wait: 900 },
      { do: "tool", tool: "search", target: "waitForTimeout", output: "e2e/login.spec.ts:18", ms: 600 },
      { do: "say", text: copy.site_demo_t1_cause },
      {
        do: "tool",
        tool: "edit",
        target: "e2e/login.spec.ts",
        added: 1,
        removed: 1,
        diff: [
          { sign: "-", code: "await page.waitForTimeout(500)" },
          { sign: "+", code: 'await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()' },
        ],
        ms: 700,
        wait: 1400,
      },
      {
        do: "approval",
        command: "pnpm test:e2e login.spec.ts --repeat-each 20",
        reason: copy.site_demo_t1_reason,
      },
      {
        do: "tool",
        tool: "run",
        target: "pnpm test:e2e login.spec.ts --repeat-each 20",
        output: "20 passed (41.2s)",
        ms: 2400,
        when: allowed,
      },
      { do: "say", text: copy.site_demo_t1_passed, when: allowed },
      { do: "say", text: copy.site_demo_deny_reply, when: denied },
      { do: "tool", tool: "mcp", target: "link_pull_request #142", ms: 500 },
      {
        do: "pr",
        number: 142,
        title: copy.site_demo_t1_pr,
        checks: { lint: "pending", typecheck: "pending", e2e: "pending" },
      },
      { do: "worked", duration: copy.site_demo_t1_worked },
      { do: "rest" },
      { do: "checks", checks: { lint: "passing" }, wait: 1300 },
      { do: "checks", checks: { typecheck: "passing" }, wait: 900 },
      { do: "checks", checks: { e2e: "passing" }, wait: 2200 },
    ],
  }

  const csvExport: ThreadSeed = {
    id: "csv-export",
    title: copy.site_demo_t2_title,
    project: "api",
    branch: "feat/csv-export",
    provider: "codex",
    ports: ["8787"],
    replyTo,
    prefill: [prompt(copy.site_demo_t2_prompt), { do: "tool", tool: "read", target: "src/routes/reports.ts", ms: 0 }],
    steps: [
      { do: "say", text: copy.site_demo_t2_plan, wait: 1200 },
      { do: "tool", tool: "search", target: "createReportStream", output: "src/reports/stream.ts:12", ms: 800 },
      {
        do: "question",
        question: copy.site_demo_t2_question,
        options: [
          { label: copy.site_demo_t2_comma, hint: copy.site_demo_t2_comma_hint },
          { label: copy.site_demo_t2_semicolon, hint: copy.site_demo_t2_semicolon_hint },
          { label: copy.site_demo_t2_tab, hint: copy.site_demo_t2_tab_hint },
        ],
      },
      { do: "say", text: (flags) => fill(copy.site_demo_t2_answer, { answer: flags.answer ?? "" }) },
      { do: "tool", tool: "edit", target: "src/csv.ts", added: 54, ms: 900 },
      { do: "tool", tool: "edit", target: "src/routes/reports.ts", added: 12, removed: 2, ms: 700 },
      { do: "tool", tool: "edit", target: "src/csv.test.ts", added: 61, ms: 800 },
      { do: "tool", tool: "run", target: "pnpm test csv", output: "14 passed (1.3s)", ms: 1600 },
      { do: "say", text: copy.site_demo_t2_done },
      { do: "worked", duration: copy.site_demo_t2_worked },
    ],
  }

  const viteUpgrade: ThreadSeed = {
    id: "vite-8",
    title: copy.site_demo_t3_title,
    project: "web",
    branch: "chore/vite-8",
    provider: "muse",
    ports: ["5173"],
    replyTo,
    prefill: [
      prompt(copy.site_demo_t3_prompt),
      { do: "tool", tool: "edit", target: "package.json", added: 3, removed: 3, ms: 0 },
      { do: "tool", tool: "run", target: "pnpm build", output: "built in 2.84s", ms: 0 },
      { do: "say", text: copy.site_demo_t3_opened },
      { do: "tool", tool: "mcp", target: "link_pull_request #139", ms: 0 },
      { do: "tool", tool: "mcp", target: "watch_pull_request #139", ms: 0 },
      {
        do: "pr",
        number: 139,
        title: copy.site_demo_t3_pr,
        checks: { lint: "passing", typecheck: "failing", e2e: "passing" },
        watching: true,
      },
      { do: "rest" },
    ],
    steps: [
      {
        do: "event",
        text: fill(copy.site_demo_watch_event, { number: 139, check: "typecheck" }),
        tone: "attention",
        wait: 9000,
      },
      { do: "say", text: copy.site_demo_t3_fix },
      {
        do: "tool",
        tool: "edit",
        target: "src/env.d.ts",
        added: 1,
        removed: 1,
        diff: [
          { sign: "-", code: '/// <reference types="vite/client" />' },
          { sign: "+", code: '/// <reference types="vite/types/importMeta" />' },
        ],
        ms: 800,
      },
      { do: "tool", tool: "run", target: "git push", output: "chore/vite-8 -> chore/vite-8", ms: 900 },
      { do: "checks", checks: { typecheck: "pending" } },
      { do: "checks", checks: { typecheck: "passing" }, wait: 2600 },
      { do: "say", text: copy.site_demo_t3_fixed },
      { do: "worked", duration: copy.site_demo_t3_worked },
    ],
  }

  const japanese: ThreadSeed = {
    id: "settings-ja",
    title: copy.site_demo_t4_title,
    project: "web",
    branch: "i18n/settings-ja",
    provider: "claude",
    ports: [],
    replyTo,
    prefill: [
      prompt(copy.site_demo_t4_prompt),
      { do: "tool", tool: "edit", target: "messages/ja.json", added: 48, ms: 0 },
      { do: "tool", tool: "run", target: "pnpm test messages", output: "1 passed (0.4s)", ms: 0 },
      { do: "say", text: copy.site_demo_t4_done },
      { do: "worked", duration: copy.site_demo_t4_worked },
    ],
    steps: [],
  }

  return [csvExport, flakyLogin, viteUpgrade, japanese]
}
