import type { ReactNode } from "react"
import type { Thread } from "../../shared/domain.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { BackgroundTaskActivity } from "./BackgroundTaskActivity.tsx"
import { SubagentActivity } from "./SubagentActivity.tsx"
import { TodoActivity } from "./TodoActivity.tsx"

export function ActivityIndicator({ thread, children }: { thread: Thread; children?: ReactNode }) {
  return (
    <section
      aria-label={m.activity_label()}
      className="relative z-10 mx-9 -mb-px flex min-h-0 animate-fade-in flex-col [--tray:color-mix(in_oklab,var(--background)_60%,transparent)] has-[>div:empty]:hidden dark:[--tray:color-mix(in_oklab,var(--popover)_60%,transparent)]"
    >
      <div className="flex max-h-[35cqh] min-h-0 flex-col divide-y divide-border/60 overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-(color:--composer-edge) bg-(--tray) px-1.5 py-1 backdrop-blur-md tray-flare-cut">
        <TodoActivity thread={thread} />
        <SubagentActivity thread={thread} />
        <BackgroundTaskActivity threadId={thread.id} />
        {children}
      </div>
      <Flare className="right-full" />
      <Flare className="left-full -scale-x-100" />
    </section>
  )
}

function Flare({ className }: { className: string }) {
  const arc = "M12.5 -0.5 A12 12 0 0 1 0.5 11.5"
  return (
    <div aria-hidden className={cn("pointer-events-none absolute bottom-0 size-3", className)}>
      {/* FIXME: an SVG fill cannot backdrop-blur, so the fill is a masked box 1px wider than the flare */}
      <div className="absolute inset-y-0 left-0 w-[13px] bg-(--tray) mask-[radial-gradient(circle_at_0.5px_-0.5px,transparent_12px,#000_12px)] backdrop-blur-md" />
      <svg width={12} height={12} className="absolute inset-0 overflow-visible">
        <path d={arc} className="fill-none stroke-(--composer-edge)" />
      </svg>
    </div>
  )
}
