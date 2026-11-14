import { resetHasPassed, type UsageLimit } from "../../shared/limits.ts"
import type { PullRequestAttention, RowState } from "../../shared/threadStatus.ts"
import { m } from "../paraglide/messages.js"
import type { ThreadLine } from "../stores/activity.ts"
import { formatSnoozeTime } from "./snooze.ts"

export interface RowDetail {
  readonly text: string
  readonly code: boolean
}

const pullRequestWords = {
  conflicting: m.sidebar_detail_conflicts,
  checksFailing: m.pr_checks_failing,
  changesRequested: m.sidebar_detail_changes_requested,
} satisfies Record<PullRequestAttention, () => string>

const words = (text: string): RowDetail => ({ text, code: false })

export const pullRequestDetail = (attention: PullRequestAttention | undefined) =>
  attention === undefined ? null : words(pullRequestWords[attention]())

const limitDetail = (limit: UsageLimit | null, now: number, locale: string) => {
  const at = limit?.reset?.at
  if (at === undefined || resetHasPassed(at, now)) return words(m.sidebar_detail_usage_limit())
  return words(m.sidebar_detail_resets({ time: formatSnoozeTime(new Date(at), new Date(now), locale) }))
}

export function rowDetail({
  state,
  line,
  limit,
  attention,
  showActivity,
  now,
  locale,
}: {
  readonly state: RowState
  readonly line: ThreadLine | undefined
  readonly limit: UsageLimit | null
  readonly attention: PullRequestAttention | undefined
  readonly showActivity: boolean
  readonly now: number
  readonly locale: string
}): RowDetail | null {
  if (state === "awaiting_approval") return line?.kind === "ask" ? line : words(m.thread_status_awaiting_approval())
  if (state === "limited") return limitDetail(limit, now, locale)
  if (state === "interrupted") return words(m.sidebar_detail_interrupted())
  if (state === "unseen_failed") return line?.kind === "failure" ? line : words(m.sidebar_detail_failed())
  if (showActivity && (state === "running" || state === "background") && line?.kind === "activity") return line
  return pullRequestDetail(attention)
}
