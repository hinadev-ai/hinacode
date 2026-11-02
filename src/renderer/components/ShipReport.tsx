import {
  shipReportMarkdown,
  type ShipReport,
  type ShipReportReason,
  type ShipVerdict,
} from "../../shared/shipReport.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { CopyButton } from "./CopyButton.tsx"
import { FileDiffIcon } from "./icons/FileDiffIcon.tsx"
import { LineCounts } from "./LineCounts.tsx"

const verdictDot = {
  ready: "bg-success",
  blocked: "bg-destructive",
  pending: "bg-attention",
  working: "bg-attention",
  empty: "bg-muted-foreground",
} satisfies Record<ShipVerdict, string>

const verdictLabel = {
  ready: () => m.ship_verdict_ready(),
  blocked: () => m.ship_verdict_blocked(),
  pending: () => m.ship_verdict_pending(),
  working: () => m.ship_verdict_working(),
  empty: () => m.ship_verdict_empty(),
} satisfies Record<ShipVerdict, () => string>

const reasonLabel = {
  checksFailing: () => m.ship_reason_checks_failing(),
  conflicting: () => m.ship_reason_conflicting(),
  changesRequested: () => m.ship_reason_changes_requested(),
  checksPending: () => m.ship_reason_checks_pending(),
  reviewRequired: () => m.ship_reason_review_required(),
  pullRequestUnknown: () => m.ship_reason_pull_request_unknown(),
  changesUnknown: () => m.ship_reason_changes_unknown(),
  threadRunning: () => m.ship_reason_thread_running(),
  awaitingApproval: () => m.ship_reason_awaiting_approval(),
  noPullRequest: () => m.ship_reason_no_pull_request(),
} satisfies Record<ShipReportReason, () => string>

interface ShipReportViewProps {
  readonly report: ShipReport
  readonly title: string
  readonly onOpenChanges?: () => void
}

export function ShipReportView({ report, title, onOpenChanges }: ShipReportViewProps) {
  const markdown = shipReportMarkdown(report, title)
  return (
    <section aria-label={m.ship_title()} className="flex flex-col gap-0.5">
      <hr aria-hidden className="mx-2 my-1 border-border" />
      <div className="flex min-h-7 items-center justify-between gap-2 pr-0.5 pl-2">
        <h3 className="truncate text-sm text-muted-foreground">{m.ship_title()}</h3>
        <CopyButton value={markdown} label={m.ship_copy()} />
      </div>
      <div className="flex min-h-8 items-center gap-2.5 px-2 text-sm">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", verdictDot[report.verdict])} />
        <span className="min-w-0 flex-1 truncate font-medium">{verdictLabel[report.verdict]()}</span>
      </div>
      {report.reasons.map((reason) => (
        <p key={reason} className="px-2 pl-6.5 text-xs text-muted-foreground">
          {reasonLabel[reason]()}
        </p>
      ))}
      <button
        type="button"
        onClick={onOpenChanges}
        disabled={onOpenChanges === undefined}
        className="flex min-h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
      >
        <FileDiffIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {report.changesUnavailable ? m.ship_reason_changes_unknown() : m.diff_summary({ count: report.files.length })}
        </span>
        {!report.changesUnavailable && <LineCounts added={report.added} removed={report.removed} />}
      </button>
    </section>
  )
}
