import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect } from "react"
import type { ModelUsage, ThreadUsage } from "../../shared/agent.ts"
import { isThreadBusy } from "../../shared/domain.ts"
import { threadUsageAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const REFRESH_WHILE_BUSY_MS = 5000

const formatTokens = (tokens: number) => new Intl.NumberFormat(getLocale(), { notation: "compact" }).format(tokens)

const modelTotal = (usage: ModelUsage) =>
  usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens + usage.outputTokens

/** A quiet strip along the bottom of the window, below the sidebar and the thread. */
export function StatusBar() {
  const { threadId } = useParams({ strict: false })
  return (
    <footer
      aria-label={m.status_bar_label()}
      className="flex h-6 shrink-0 items-center justify-end gap-3 border-t border-sidebar-border bg-sidebar px-2 text-xs text-muted-foreground"
    >
      {threadId !== undefined && <ThreadTokens key={threadId} threadId={threadId} />}
    </footer>
  )
}

function ThreadTokens({ threadId }: { threadId: string }) {
  const atom = threadUsageAtom(threadId)
  const usage = AsyncResult.getOrElse(useAtomValue(atom), () => null)
  const refresh = useAtomRefresh(atom)
  const busy = useThreads((state) => {
    const status = state.byId[threadId]?.status
    return status !== undefined && isThreadBusy(status)
  })

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(refresh, REFRESH_WHILE_BUSY_MS)
    return () => clearInterval(timer)
  }, [busy, refresh])

  if (usage === null || usage.models.length === 0) return null
  const tokens = formatTokens(usage.models.reduce((sum, model) => sum + modelTotal(model), 0))
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={m.usage_label({ tokens })}
        className="h-5 rounded-sm px-1.5 tabular-nums outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.usage_tokens({ tokens })}
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-none flex-col items-stretch gap-2 py-2">
        <UsageBreakdown usage={usage} />
      </TooltipContent>
    </Tooltip>
  )
}

function UsageBreakdown({ usage }: { usage: ThreadUsage }) {
  const agents = usage.transcripts - 1
  const columns = [
    [m.usage_input(), "inputTokens"],
    [m.usage_cache_write(), "cacheWriteTokens"],
    [m.usage_cache_read(), "cacheReadTokens"],
    [m.usage_output(), "outputTokens"],
  ] as const
  return (
    <>
      <table className="tabular-nums">
        <thead className="text-background/70">
          <tr>
            <th scope="col" className="pr-4 text-left font-normal">
              {m.usage_model()}
            </th>
            {columns.map(([label]) => (
              <th key={label} scope="col" className="pl-4 text-right font-normal">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {usage.models.map((model) => (
            <tr key={model.model}>
              <th scope="row" className="pt-1 pr-4 text-left font-medium">
                {model.model}
              </th>
              {columns.map(([label, field]) => (
                <td key={label} className="pt-1 pl-4 text-right">
                  {formatTokens(model[field])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-background/70">
        {agents === 0 ? m.usage_main_session_only() : m.usage_main_session_and_agents({ count: agents })}
      </p>
    </>
  )
}
