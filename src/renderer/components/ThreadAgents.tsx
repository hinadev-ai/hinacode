import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useState } from "react"
import { RiCheckLine, RiErrorWarningLine, RiStopCircleLine, RiStopFill } from "react-icons/ri"
import { toast } from "sonner"
import type { Subagent, SubagentStatus } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { loadSubagentsAtom, useSubagents } from "../stores/subagents.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { useOpenSubagent } from "../lib/subagents.ts"
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

export const subagentStatusLabel = {
  running: m.agents_status_running,
  completed: m.agents_status_completed,
  failed: m.agents_status_failed,
  stopped: m.agents_status_stopped,
} satisfies Record<SubagentStatus, () => string>

// Running is a still dot: a batch of ten sub-agents would otherwise be ten spinners.
const statusIcons = {
  running: <span aria-hidden className="size-1/2 rounded-full bg-working" />,
  completed: <RiCheckLine aria-hidden className="size-full text-muted-foreground" />,
  failed: <RiErrorWarningLine aria-hidden className="size-full text-destructive" />,
  stopped: <RiStopCircleLine aria-hidden className="size-full text-muted-foreground" />,
} satisfies Record<SubagentStatus, ReactNode>

/** `className` sizes the icon, `size-4` by default. */
export function SubagentStatusIcon({ status, className }: { status: SubagentStatus; className?: string }) {
  return (
    <span
      title={subagentStatusLabel[status]()}
      className={cn("flex size-4 shrink-0 items-center justify-center", className)}
    >
      {statusIcons[status]}
      <span className="sr-only">{subagentStatusLabel[status]()}</span>
    </span>
  )
}

/** Re-renders every second while `ticking`, so running timers count up. */
export function useNow(ticking: boolean) {
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
export const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0
    ? `${formatUnit(minutes, "minute")} ${formatUnit(seconds % 60, "second")}`
    : formatUnit(seconds, "second")
}

export const formatTokens = (tokens: number) =>
  new Intl.NumberFormat(getLocale(), { notation: "compact" }).format(tokens)

/** Summaries can be multi-line markdown; the row shows the first line and keeps the rest in the tooltip. */
const firstLine = (text: string) =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? ""

/** Sub-agents the thread's agent spawned, as the body of the Agents tab. */
export function ThreadAgents({ thread }: { thread: Thread }) {
  const { load, reload, subagents } = useThreadSubagents(thread.id)
  const open = useOpenSubagent(thread.id)
  const now = useNow(subagents?.some((subagent) => subagent.status === "running") ?? false)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  if (!subagents) {
    return AsyncResult.builder(load)
      .onError((error) => (
        <div role="alert" className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs wrap-anywhere text-destructive">
            {m.agents_failed({ message: errorMessage(error) })}
          </p>
          <Button variant="outline" size="xs" onClick={reload}>
            {m.common_retry()}
          </Button>
        </div>
      ))
      .orElse(() => <SkeletonList label={m.agents_loading()} rows={2} rowClassName="h-10" />)
  }

  if (subagents.length === 0) return <p className="text-xs text-muted-foreground">{m.agents_empty()}</p>

  return (
    <ul ref={listRef} aria-label={m.agents_list_label()} className="flex flex-col gap-1">
      {subagents.map((subagent) => {
        const { callId } = subagent
        return (
          <SubagentRow
            key={subagent.id}
            threadId={thread.id}
            subagent={subagent}
            provider={thread.provider}
            now={now}
            onOpen={callId === null ? undefined : () => open(callId)}
          />
        )
      })}
    </ul>
  )
}

export const subagentStats = (subagent: Subagent, now: number) =>
  [
    subagent.toolUses === null ? null : m.agents_tools({ count: subagent.toolUses }),
    subagent.tokens ? m.agents_tokens({ tokens: formatTokens(subagent.tokens) }) : null,
    formatElapsed((subagent.endedAt === null ? now : Date.parse(subagent.endedAt)) - Date.parse(subagent.startedAt)),
  ]
    .filter((stat) => stat !== null)
    .join(" · ")

/** What a sub-agent is doing now, or what it reported when it ended. */
export const subagentDetail = (subagent: Subagent) =>
  subagent.summary
    ? firstLine(subagent.summary)
    : subagent.lastTool
      ? m.agents_last_tool({ tool: subagent.lastTool })
      : null

/** Stops one running sub-agent. Its turn keeps going. */
export function StopSubagentButton({
  threadId,
  subagent,
  className,
}: {
  threadId: string
  subagent: Subagent
  className?: string
}) {
  const stop = async () => {
    try {
      await callPromise("subagents.stop", { threadId, subagentId: subagent.id })
    } catch (cause) {
      toast.error(m.agents_stop_failed({ message: errorMessage(cause) }))
    }
  }
  const label = m.agents_stop({ label: subagent.label })
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      action={stop}
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      <RiStopFill aria-hidden className="size-3 fill-current" />
    </Button>
  )
}

function SubagentRow({
  threadId,
  subagent,
  provider,
  now,
  onOpen,
}: {
  threadId: string
  subagent: Subagent
  provider: Thread["provider"]
  now: number
  onOpen: (() => void) | undefined
}) {
  const detail = subagentDetail(subagent)
  const body = (
    <>
      <span className="mt-0.5">
        <SubagentStatusIcon status={subagent.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-sm",
            subagent.status === "running" && "text-muted-foreground",
          )}
        >
          <ProviderIcon provider={provider} />
          <span className="truncate" title={subagent.label}>
            {subagent.label}
          </span>
        </span>
        {detail && (
          <span className="truncate text-xs text-muted-foreground" title={subagent.summary ?? undefined}>
            {detail}
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">{subagentStats(subagent, now)}</span>
      </span>
    </>
  )

  return (
    <li className="group/row flex items-start gap-1">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="-ml-2 flex min-w-0 flex-1 gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 gap-2.5 py-1.5">{body}</div>
      )}
      {subagent.status === "running" && (
        // Shows on hover or focus, so a long list does not grow a column of stop buttons.
        <StopSubagentButton
          threadId={threadId}
          subagent={subagent}
          className="mt-1 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
        />
      )}
    </li>
  )
}
