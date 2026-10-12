import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useState } from "react"
import { RiCheckLine, RiErrorWarningLine, RiLoader4Line, RiStopCircleLine } from "react-icons/ri"
import type { Subagent, SubagentStatus } from "../../shared/agent.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { loadSubagentsAtom, useSubagents } from "../stores/subagents.ts"
import { Button } from "./ui/button.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"

const NO_SUBAGENTS: ReadonlyArray<Subagent> = []

/** The thread's sub-agents, newest first, loading them on first use. Updates live. */
export function useThreadSubagents(threadId: string) {
  const loadAtom = loadSubagentsAtom(threadId)
  const load = useAtomValue(loadAtom)
  const reload = useAtomRefresh(loadAtom)
  const subagents = useSubagents((state) => state.byThreadId[threadId])
  return { load, reload, subagents }
}

export const useRunningSubagentCount = (threadId: string) =>
  (useThreadSubagents(threadId).subagents ?? NO_SUBAGENTS).filter((subagent) => subagent.status === "running").length

const statusLabel = {
  running: m.agents_status_running,
  completed: m.agents_status_completed,
  failed: m.agents_status_failed,
  stopped: m.agents_status_stopped,
} satisfies Record<SubagentStatus, () => string>

const statusIcon = {
  running: <RiLoader4Line aria-hidden className="size-4 animate-spin text-working motion-reduce:animate-none" />,
  completed: <RiCheckLine aria-hidden className="size-4 text-muted-foreground" />,
  failed: <RiErrorWarningLine aria-hidden className="size-4 text-destructive" />,
  stopped: <RiStopCircleLine aria-hidden className="size-4 text-muted-foreground" />,
} satisfies Record<SubagentStatus, ReactNode>

/** Re-renders every second while `ticking`, so running timers count up. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

const formatUnit = (value: number, unit: "minute" | "second") =>
  new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: "narrow" }).format(value)

/** "1m 20s", or "45s" under a minute. */
const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0
    ? `${formatUnit(minutes, "minute")} ${formatUnit(seconds % 60, "second")}`
    : formatUnit(seconds, "second")
}

const formatTokens = (tokens: number) => new Intl.NumberFormat(getLocale(), { notation: "compact" }).format(tokens)

/** Summaries can be multi-line markdown; the row shows the first line and keeps the rest in the tooltip. */
const firstLine = (text: string) =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? ""

/** Sub-agents the thread's agent spawned, as the body of the Agents tab. */
export function ThreadAgents({ threadId }: { threadId: string }) {
  const { load, reload, subagents } = useThreadSubagents(threadId)
  const now = useNow(subagents?.some((subagent) => subagent.status === "running") ?? false)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  if (!subagents) {
    return AsyncResult.builder(load)
      .onError((error) => (
        <div role="alert" className="flex items-center gap-2">
          <p className="text-xs text-destructive">{m.agents_failed({ message: errorMessage(error) })}</p>
          <Button variant="outline" size="xs" onClick={reload}>
            {m.common_retry()}
          </Button>
        </div>
      ))
      .orElse(() => <SkeletonList label={m.agents_loading()} rows={2} rowClassName="h-10" />)
  }

  if (subagents.length === 0) return <p className="text-xs text-muted-foreground">{m.agents_empty()}</p>

  return (
    <ul ref={listRef} aria-label={m.agents_list_label()} className="flex flex-col gap-4">
      {subagents.map((subagent) => (
        <SubagentRow key={subagent.id} subagent={subagent} now={now} />
      ))}
    </ul>
  )
}

function SubagentRow({ subagent, now }: { subagent: Subagent; now: number }) {
  const ended = subagent.endedAt === null ? now : Date.parse(subagent.endedAt)
  const detail = subagent.summary
    ? firstLine(subagent.summary)
    : subagent.lastTool
      ? m.agents_last_tool({ tool: subagent.lastTool })
      : null
  const stats = [
    subagent.toolUses === null ? null : m.agents_tools({ count: subagent.toolUses }),
    subagent.tokens ? m.agents_tokens({ tokens: formatTokens(subagent.tokens) }) : null,
    formatElapsed(ended - Date.parse(subagent.startedAt)),
  ].filter((stat) => stat !== null)

  return (
    <li className="flex gap-2.5">
      <span title={statusLabel[subagent.status]()} className="mt-0.5 shrink-0">
        {statusIcon[subagent.status]}
        <span className="sr-only">{statusLabel[subagent.status]()}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{subagent.kind}</span>
          <span className="truncate" title={subagent.label}>
            {subagent.label}
          </span>
        </p>
        {detail && (
          <p className="truncate text-xs text-muted-foreground" title={subagent.summary ?? undefined}>
            {detail}
          </p>
        )}
        <p className="text-xs text-muted-foreground tabular-nums">{stats.join(" · ")}</p>
      </div>
    </li>
  )
}
