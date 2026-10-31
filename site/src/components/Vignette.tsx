import type { ReactNode } from "react"
import { RiGitMergeLine } from "react-icons/ri"
import { fill } from "../fill.ts"
import { BranchIcon, CheckCircleFillIcon, ShieldIcon } from "../icons.ts"
import type { DemoCopy } from "../demo/copy.ts"
import type { ProviderId, ThreadStatus } from "../demo/engine.ts"
import { buttonStyles, providerName, ProviderMark, StatusGlyph } from "../demo/ui.tsx"

export type VignetteId = "start" | "watch" | "steer" | "review" | "ship"

const paperCard =
  "bg-paper shadow-[0_0_0_1px_oklch(0_0_0/0.06),0_1px_2px_oklch(0_0_0/0.04),0_12px_28px_-12px_oklch(0.32_0.026_196/0.16)]"
const attentionCard =
  "bg-attention-soft shadow-[0_0_0_1px_var(--color-attention-line),0_1px_2px_oklch(0_0_0/0.04),0_12px_28px_-12px_oklch(0.32_0.026_196/0.16)]"

function Frame({ children, className = paperCard }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none w-full max-w-[22rem] rounded-xl p-3 text-ink select-none ${className}`}
    >
      {children}
    </div>
  )
}

function Worktrees({ copy }: { copy: DemoCopy }) {
  const branches: [string, ProviderId][] = [
    ["fix/flaky-login", "claude"],
    ["feat/csv-export", "codex"],
    ["chore/vite-8", "muse"],
  ]
  return (
    <Frame>
      <p className="flex items-center gap-1.5 px-1 font-mono text-[11.5px]">
        <BranchIcon className="size-3.5 text-ink-soft" />
        main
      </p>
      <ul className="mt-1.5 ms-[0.6875rem] border-s border-line-strong">
        {branches.map(([branch, provider]) => (
          <li key={branch} className="flex items-center gap-2 py-1 ps-3 text-[11.5px]">
            <span className="font-mono">{branch}</span>
            <span className="ms-auto flex items-center gap-1 text-ink-soft">
              <ProviderMark provider={provider} className="size-3" />
              {providerName(copy, provider)}
            </span>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

function Inbox({ copy }: { copy: DemoCopy }) {
  const rows: [string, ThreadStatus, string][] = [
    [copy.site_demo_t2_title, "needs-you", copy.site_demo_needs_you],
    [copy.site_demo_t1_title, "running", copy.thread_status_running],
    [copy.site_demo_t3_title, "failing", copy.pr_checks_failing],
    [copy.site_demo_t4_title, "done", copy.site_demo_done],
  ]
  return (
    <Frame>
      <ul className="space-y-0.5">
        {rows.map(([title, status, label]) => (
          <li key={title} className="flex items-start gap-2 rounded-lg px-2 py-1.5">
            <span className="mt-[2px]">
              <StatusGlyph status={status} unseen={status === "done"} copy={copy} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] font-medium">{title}</span>
              <span
                className={`block text-[11px] ${status === "needs-you" ? "font-semibold text-attention" : "text-ink-soft"}`}
              >
                {label}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

function Approval({ copy }: { copy: DemoCopy }) {
  return (
    <Frame className={attentionCard}>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold">
        <ShieldIcon className="size-3.5 text-attention" />
        {fill(copy.approval_title, { provider: copy.provider_claude })}
      </p>
      <p className="mt-2 truncate rounded-md bg-paper px-2 py-1.5 font-mono text-[11px] shadow-[0_0_0_1px_var(--color-line)]">
        $ pnpm test:e2e login.spec.ts
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <span className={buttonStyles.primary}>{copy.approval_allow}</span>
        <span className={buttonStyles.secondary}>{copy.approval_allow_session}</span>
        <span className={buttonStyles.ghost}>{copy.approval_deny}</span>
      </div>
    </Frame>
  )
}

function Diff() {
  return (
    <Frame>
      <p className="px-1 font-mono text-[11.5px] text-ink-soft">
        e2e/login.spec.ts <span className="text-teal">+1</span> <span className="text-danger">−1</span>
      </p>
      <pre className="mt-2 overflow-hidden rounded-lg bg-surface py-1.5 font-mono text-[11px] leading-5 shadow-[0_0_0_1px_var(--color-line)]">
        <span className="block px-2.5 text-ink">{'test("signs in", async ({ page }) => {'}</span>
        <span className="block truncate bg-danger-soft px-2.5">
          <span className="text-danger">− </span>
          {"  await page.waitForTimeout(500)"}
        </span>
        <span className="block truncate bg-teal-soft px-2.5">
          <span className="text-teal">+ </span>
          {"  await expect(heading).toBeVisible()"}
        </span>
        <span className="block px-2.5 text-ink">{"})"}</span>
      </pre>
    </Frame>
  )
}

function PullRequest({ copy }: { copy: DemoCopy }) {
  return (
    <Frame>
      <div className="flex items-start gap-2 px-1">
        <RiGitMergeLine className="mt-0.5 size-4 shrink-0 text-merged" />
        <div className="min-w-0">
          <p className="text-[12.5px] leading-snug font-medium">{copy.site_demo_t1_pr}</p>
          <p className="mt-0.5 text-[11px] text-ink-soft">#142 · {copy.pr_state_merged}</p>
        </div>
      </div>
      <ul className="mt-2.5 flex gap-3 px-1">
        {["lint", "typecheck", "e2e"].map((name) => (
          <li key={name} className="flex items-center gap-1 font-mono text-[11px]">
            <CheckCircleFillIcon className="size-3 text-teal" />
            {name}
          </li>
        ))}
      </ul>
      <p className="mt-2.5 rounded-lg bg-teal-soft px-2.5 py-1.5 text-[11px] text-teal">
        {fill(copy.site_demo_merged_event, { number: 142 })}
      </p>
    </Frame>
  )
}

export default function Vignette({ id, copy }: { id: VignetteId; copy: DemoCopy }) {
  switch (id) {
    case "start":
      return <Worktrees copy={copy} />
    case "watch":
      return <Inbox copy={copy} />
    case "steer":
      return <Approval copy={copy} />
    case "review":
      return <Diff />
    case "ship":
      return <PullRequest copy={copy} />
  }
}
