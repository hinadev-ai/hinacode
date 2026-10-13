import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useSearch } from "@tanstack/react-router"
import type { Subagent } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import { useOpenSubagent } from "../lib/subagents.ts"
import { m } from "../paraglide/messages.js"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SubagentStatusIcon, useThreadSubagents } from "./ThreadAgents.tsx"

const NO_SUBAGENTS: ReadonlyArray<Subagent> = []

/**
 * The batch still in flight: every running sub-agent, plus those that ended after the oldest of
 * them started, so a parallel batch keeps its finished members until the last one is done.
 */
function inFlight(subagents: ReadonlyArray<Subagent>) {
  const running = subagents.filter((subagent) => subagent.status === "running")
  if (running.length === 0) return []
  const since = Math.min(...running.map((subagent) => Date.parse(subagent.startedAt)))
  return subagents.filter((subagent) => subagent.endedAt === null || Date.parse(subagent.endedAt) >= since).toReversed()
}

/** Above the composer while sub-agents run, so the user sees them without opening the Agents tab. */
export function SubagentBar({ thread }: { thread: Thread }) {
  const subagents = inFlight(useThreadSubagents(thread.id).subagents ?? NO_SUBAGENTS)
  const { agent } = useSearch({ from: "/thread/$threadId" })
  const open = useOpenSubagent(thread.id)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })
  const running = subagents.filter((subagent) => subagent.status === "running").length
  if (subagents.length === 0) return null

  return (
    <nav aria-label={m.agents_list_label()} className="flex animate-fade-in items-center gap-2 px-1 pb-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground tabular-nums">{m.agents_running_count({ count: running })}</span>
      <ul ref={listRef} className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {subagents.map((subagent) => {
          const { callId } = subagent
          return (
            <li key={subagent.id} className="min-w-0 shrink-0">
              <button
                type="button"
                disabled={callId === null}
                onClick={() => callId !== null && open(callId)}
                aria-current={callId !== null && callId === agent ? "page" : undefined}
                title={subagent.label}
                className="pressable flex max-w-56 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none aria-[current=page]:border-ring aria-[current=page]:bg-muted"
              >
                <SubagentStatusIcon status={subagent.status} />
                <ProviderIcon provider={thread.provider} />
                <span className="truncate">{subagent.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
