import type { AutomationRunStatus, AutomationTriggerType } from "../../../../shared/domain.ts"
import { m } from "../../../paraglide/messages.js"
import { getLocale } from "../../../paraglide/runtime.js"
import { Badge } from "../../ui/badge.tsx"
import { CopyButton } from "../../CopyButton.tsx"

export const triggerLabel = {
  webhook: m.automations_trigger_webhook,
  "github.issue": m.automations_trigger_github,
  "linear.issue": m.automations_trigger_linear,
  "slack.mention": m.automations_trigger_slack,
} satisfies Record<AutomationTriggerType, () => string>

const runStatusLabel = {
  started: m.automations_run_started,
  skipped: m.automations_run_skipped,
  failed: m.automations_run_failed,
} satisfies Record<AutomationRunStatus, () => string>

const runStatusVariant = {
  started: "secondary",
  skipped: "outline",
  failed: "destructive",
} as const satisfies Record<AutomationRunStatus, "secondary" | "outline" | "destructive">

export function RunStatusBadge({ status }: { status: AutomationRunStatus }) {
  return <Badge variant={runStatusVariant[status]}>{runStatusLabel[status]()}</Badge>
}

export const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))

/** A read-only monospace value with a copy button. */
export function CopyField({ id, value, copyLabel }: { id: string; value: string; copyLabel: string }) {
  return (
    <div className="flex items-center gap-2">
      <output
        id={id}
        className="min-w-0 flex-1 rounded-lg border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-xs break-all"
        title={value}
      >
        {value}
      </output>
      <CopyButton value={value} label={copyLabel} variant="outline" />
    </div>
  )
}
