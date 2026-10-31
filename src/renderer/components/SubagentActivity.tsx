import type { Subagent, SubagentStatus } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { ActivityRow } from "./ActivityRow.tsx"
import { subagentDetail, useThreadSubagents } from "./ThreadAgents.tsx"

const NO_SUBAGENTS: ReadonlyArray<Subagent> = []

const segmentColor = {
  running: "bg-working",
  completed: "bg-muted-foreground",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/30",
} satisfies Record<SubagentStatus, string>

function inFlight(subagents: ReadonlyArray<Subagent>) {
  const running = subagents.filter((subagent) => subagent.status === "running")
  if (running.length === 0) return []
  const since = Math.min(...running.map((subagent) => Date.parse(subagent.startedAt)))
  return subagents.filter((subagent) => subagent.endedAt === null || Date.parse(subagent.endedAt) >= since).toReversed()
}

export function SubagentActivity({ thread }: { thread: Thread }) {
  const subagents = inFlight(useThreadSubagents(thread.id).subagents ?? NO_SUBAGENTS)
  const showView = useUi((state) => state.showView)
  if (subagents.length === 0) return null

  const running = subagents.filter((subagent) => subagent.status === "running")
  const failed = subagents.filter((subagent) => subagent.status === "failed").length
  const newest = running.at(-1)
  const detail = newest && subagentDetail(newest)

  return (
    <ActivityRow onClick={() => showView(thread.id, "agents", { focus: true })}>
      <span aria-hidden className="flex h-1.5 w-24 shrink-0 gap-px overflow-hidden rounded-full">
        {subagents.map((subagent) => (
          <span key={subagent.id} className={cn("min-w-px flex-1", segmentColor[subagent.status])} />
        ))}
      </span>
      <span className="shrink-0 tabular-nums">
        {m.agents_batch_running({ running: running.length, total: subagents.length })}
      </span>
      {failed > 0 && (
        <span className="shrink-0 text-destructive tabular-nums">{m.agents_batch_failed({ count: failed })}</span>
      )}
      {newest && (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-foreground" title={newest.label}>
            {newest.label}
          </span>
          {detail && (
            <span className="shrink-4 truncate" title={newest.summary ?? undefined}>
              {detail}
            </span>
          )}
        </span>
      )}
    </ActivityRow>
  )
}
