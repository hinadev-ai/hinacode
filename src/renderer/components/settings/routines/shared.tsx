import type { RoutineRunSource, RoutineRunStatus } from "../../../../shared/domain.ts"
import { m } from "../../../paraglide/messages.js"
import { getLocale } from "../../../paraglide/runtime.js"
import { Badge } from "../../ui/badge.tsx"

const runStatusLabel = {
  started: m.routines_run_started,
  skipped: m.routines_run_skipped,
  failed: m.routines_run_failed,
} satisfies Record<RoutineRunStatus, () => string>

const runStatusVariant = {
  started: "secondary",
  skipped: "outline",
  failed: "destructive",
} as const satisfies Record<RoutineRunStatus, "secondary" | "outline" | "destructive">

export const runSourceLabel = {
  schedule: m.routines_source_schedule,
  webhook: m.routines_source_webhook,
  manual: m.routines_source_manual,
} satisfies Record<RoutineRunSource, () => string>

export function RunStatusBadge({ status }: { status: RoutineRunStatus }) {
  return <Badge variant={runStatusVariant[status]}>{runStatusLabel[status]()}</Badge>
}

export const formatTime = (iso: string | Date, timeZone?: string) =>
  new Intl.DateTimeFormat(getLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(typeof iso === "string" ? new Date(iso) : iso)

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
