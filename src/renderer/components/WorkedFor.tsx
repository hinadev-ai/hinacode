import { RiArrowRightSLine } from "react-icons/ri"
import { formatWorkDuration } from "../lib/assistantPresentation.ts"
import { m } from "../paraglide/messages.js"

const rowClassName =
  "mb-2 flex min-h-8 w-full items-center gap-1.5 border-b border-border text-xs text-muted-foreground tabular-nums"

export function WorkedFor({
  durationMs,
  expanded = false,
  onExpandedChange,
}: {
  durationMs: number
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const label = m.message_worked_for({ duration: formatWorkDuration(durationMs) })
  if (onExpandedChange === undefined) {
    return (
      <div data-slot="worked-for" className={rowClassName}>
        {label}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-slot="worked-for"
      aria-expanded={expanded}
      title={expanded ? m.message_hide_activity() : m.message_show_activity()}
      onClick={() => onExpandedChange(!expanded)}
      className={`${rowClassName} group/trigger text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring`}
    >
      {label}
      <RiArrowRightSLine
        aria-hidden
        className="size-3.5 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90 motion-reduce:transition-none"
      />
    </button>
  )
}
