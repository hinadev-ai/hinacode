import type { ReactNode } from "react"
import type { Thread } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { BackgroundTaskActivity } from "./BackgroundTaskActivity.tsx"
import { SubagentActivity } from "./SubagentActivity.tsx"
import { TodoActivity } from "./TodoActivity.tsx"

export function ActivityIndicator({ thread, children }: { thread: Thread; children?: ReactNode }) {
  return (
    <section
      aria-label={m.activity_label()}
      className="mx-9 flex min-h-0 animate-fade-in flex-col [--tray:color-mix(in_oklab,var(--background)_60%,transparent)] has-[>div:empty]:hidden dark:[--tray:color-mix(in_oklab,var(--popover)_60%,transparent)]"
    >
      <div className="flex max-h-[35cqh] min-h-0 flex-col divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-(color:--composer-edge) bg-(--tray) px-1.5 py-1 backdrop-blur-md">
        <TodoActivity thread={thread} />
        <SubagentActivity thread={thread} />
        <BackgroundTaskActivity threadId={thread.id} />
        {children}
      </div>
    </section>
  )
}
