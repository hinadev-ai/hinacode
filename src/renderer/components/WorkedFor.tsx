import { formatWorkDuration } from "../lib/assistantPresentation.ts"
import { m } from "../paraglide/messages.js"
import { ChevronRightIcon } from "./icons/ChevronRightIcon.tsx"

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
  return <ActivityToggle slot="worked-for" label={label} expanded={expanded} onExpandedChange={onExpandedChange} />
}

export function EarlierActivity({
  count,
  expanded,
  onExpandedChange,
}: {
  count: number
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  return (
    <ActivityToggle
      slot="earlier-activity"
      label={m.message_earlier_activity({ count })}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />
  )
}

function ActivityToggle({
  slot,
  label,
  expanded,
  onExpandedChange,
}: {
  slot: string
  label: string
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  return (
    <button
      type="button"
      data-slot={slot}
      aria-expanded={expanded}
      title={expanded ? m.message_hide_activity() : m.message_show_activity()}
      onClick={() => onExpandedChange(!expanded)}
      className={`${rowClassName} group/trigger text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring`}
    >
      {label}
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 shrink-0 transition-transform group-aria-expanded/trigger:rotate-90 motion-reduce:transition-none"
      />
    </button>
  )
}
