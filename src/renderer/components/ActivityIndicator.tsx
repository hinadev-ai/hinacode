import type { Thread } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { BackgroundTaskActivity } from "./BackgroundTaskActivity.tsx"
import { SubagentActivity } from "./SubagentActivity.tsx"
import { TodoActivity } from "./TodoActivity.tsx"

/**
 * Long-running work of the thread's agent, docked on top of the composer. The plan comes first, then the
 * sub-agents in flight, then background tasks, which outlive the turn and sit nearest the input with their stop
 * buttons. A section with nothing to show renders nothing, and the tray hides once every section does.
 */
export function ActivityIndicator({ thread }: { thread: Thread }) {
  return (
    <section
      aria-label={m.activity_label()}
      className="mx-3 flex max-h-[35cqh] min-h-0 animate-fade-in flex-col divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-border/60 bg-background/60 px-1.5 py-1 backdrop-blur-md empty:hidden dark:bg-popover/60"
    >
      <TodoActivity thread={thread} />
      <SubagentActivity thread={thread} />
      <BackgroundTaskActivity threadId={thread.id} />
    </section>
  )
}
