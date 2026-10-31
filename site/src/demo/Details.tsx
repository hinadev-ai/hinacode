import { startTransition, type ActionDispatch } from "react"
import { RiGitMergeLine, RiGitPullRequestLine } from "react-icons/ri"
import { fill } from "../fill.ts"
import { BranchIcon, CheckCircleFillIcon, EyeIcon, GlobeIcon, SpinnerIcon, XCircleFillIcon } from "../icons.ts"
import type { DemoCopy } from "./copy.ts"
import type { Action, CheckStatus, PullRequest, Thread } from "./engine.ts"
import { buttonStyles, Section } from "./ui.tsx"

const MERGE_MS = 1100

type Props = { thread: Thread; copy: DemoCopy; dispatch: ActionDispatch<[Action]> }

export function Details({ thread, copy, dispatch }: Props) {
  const changes = new Map<string, { added: number; removed: number }>()
  for (const item of thread.items) {
    if (item.kind !== "tool" || item.tool !== "edit" || item.running) continue
    const total = changes.get(item.target) ?? { added: 0, removed: 0 }
    changes.set(item.target, { added: total.added + (item.added ?? 0), removed: total.removed + (item.removed ?? 0) })
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-4">
      <Section title={copy.panel_workspace}>
        <p className="flex items-center gap-1.5 text-xs text-ink">
          <BranchIcon aria-hidden className="size-3.5 shrink-0 text-ink-soft" />
          <span className="truncate font-mono text-[11.5px]">{thread.branch}</span>
        </p>
        <p
          className={`mt-1 truncate font-mono text-[11px] text-ink-soft ${thread.worktreeRemoved ? "line-through" : ""}`}
          title={copy.site_demo_worktree}
        >
          ~/.hinacode/worktrees/{thread.project}/{thread.branch.replace("/", "-")}
        </p>
      </Section>

      <Section title={copy.panel_changes}>
        {changes.size === 0 ? (
          <p className="text-xs text-ink-soft">{copy.site_demo_no_changes}</p>
        ) : (
          <ul className="space-y-1">
            {[...changes].map(([path, { added, removed }]) => (
              <li key={path} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{path}</span>
                <span className="font-mono text-[11px] text-teal tabular-nums">+{added}</span>
                {removed > 0 && <span className="font-mono text-[11px] text-danger tabular-nums">−{removed}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={copy.ports_title}>
        {thread.ports.length === 0 ? (
          <p className="text-xs text-ink-soft">{copy.site_demo_no_ports}</p>
        ) : (
          <ul className="space-y-1">
            {thread.ports.map((port) => (
              <li key={port} className="flex items-center gap-1.5 font-mono text-[11.5px] text-ink">
                <GlobeIcon aria-hidden className="size-3.5 text-ink-soft" />
                localhost:{port}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={copy.pr_links_title}>
        {thread.pr ? (
          <PullRequestCard pr={thread.pr} {...{ thread, copy, dispatch }} />
        ) : (
          <p className="text-xs text-ink-soft">{copy.site_demo_no_pr}</p>
        )}
      </Section>
    </div>
  )
}

function checksSummary(copy: DemoCopy, checks: CheckStatus[]) {
  if (checks.includes("failing")) return { text: copy.pr_checks_failing, tone: "text-danger" }
  if (checks.includes("pending")) return { text: copy.pr_checks_pending, tone: "text-ink-soft" }
  return { text: copy.pr_checks_passing, tone: "text-teal" }
}

function CheckGlyph({ status }: { status: CheckStatus }) {
  if (status === "passing") return <CheckCircleFillIcon aria-hidden className="size-3.5 text-teal" />
  if (status === "failing") return <XCircleFillIcon aria-hidden className="size-3.5 text-danger" />
  return <SpinnerIcon aria-hidden className="size-3.5 animate-spin text-ink-soft [--sun:var(--color-coral)]" />
}

function PullRequestCard({ pr, thread, copy, dispatch }: Props & { pr: PullRequest }) {
  const statuses = Object.values(pr.checks)
  const summary = checksSummary(copy, statuses)
  const mergeable = pr.state === "open" && statuses.every((status) => status === "passing")
  const merged = pr.state === "merged"

  const merge = () => {
    startTransition(() => dispatch({ type: "merge", threadId: thread.id }))
    setTimeout(
      () =>
        startTransition(() =>
          dispatch({
            type: "merged",
            threadId: thread.id,
            event: fill(copy.site_demo_merged_event, { number: pr.number }),
          }),
        ),
      MERGE_MS,
    )
  }

  return (
    <div className="rounded-xl bg-paper p-3 shadow-[0_0_0_1px_var(--color-line),0_1px_2px_oklch(0_0_0/0.04)]">
      <div className="flex items-start gap-2">
        {merged ? (
          <RiGitMergeLine aria-hidden className="mt-0.5 size-4 shrink-0 text-merged" />
        ) : (
          <RiGitPullRequestLine aria-hidden className="mt-0.5 size-4 shrink-0 text-teal" />
        )}
        <div className="min-w-0">
          <p className="text-[13px] leading-snug font-medium text-pretty text-ink">{pr.title}</p>
          <p className="mt-0.5 text-xs text-ink-soft">
            #{pr.number} · {merged ? copy.pr_state_merged : copy.pr_state_open}
          </p>
        </div>
      </div>
      {pr.watching && !merged && (
        <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-ink-soft">
          <EyeIcon aria-hidden className="size-3" />
          {copy.site_demo_watching}
        </p>
      )}
      {!merged && (
        <>
          <ul className="mt-3 space-y-1.5" aria-label={summary.text}>
            {Object.entries(pr.checks).map(([name, status]) => (
              <li key={name} className="flex items-center gap-2 font-mono text-[11.5px] text-ink">
                <CheckGlyph status={status} />
                {name}
              </li>
            ))}
          </ul>
          <p className={`mt-2 text-xs font-medium ${summary.tone}`} aria-live="polite">
            {summary.text}
          </p>
          <button type="button" disabled={!mergeable} onClick={merge} className={`${buttonStyles.primary} mt-3 w-full`}>
            {pr.state === "merging" && <SpinnerIcon aria-hidden className="size-3.5 animate-spin" />}
            {pr.state === "merging" ? copy.site_demo_merging : copy.pr_merge_squash}
          </button>
        </>
      )}
    </div>
  )
}
