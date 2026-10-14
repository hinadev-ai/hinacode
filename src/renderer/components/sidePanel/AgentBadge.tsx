import { m } from "../../paraglide/messages.js"
import { useRunningSubagentCount } from "../ThreadAgents.tsx"

export function AgentBadge({ threadId }: { threadId: string }) {
  const count = useRunningSubagentCount(threadId)
  if (count === 0) return null
  return (
    <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-working px-1 text-[0.625rem] font-medium text-background tabular-nums">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{m.agents_running_count({ count })}</span>
    </span>
  )
}
