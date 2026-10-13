import { formatWorkDuration } from "../lib/assistantPresentation.ts"
import { m } from "../paraglide/messages.js"

export function WorkedFor({ durationMs }: { durationMs: number }) {
  return (
    <div
      data-slot="worked-for"
      className="mb-2 flex min-h-8 items-center border-b border-border text-xs text-muted-foreground tabular-nums"
    >
      {m.message_worked_for({ duration: formatWorkDuration(durationMs) })}
    </div>
  )
}
