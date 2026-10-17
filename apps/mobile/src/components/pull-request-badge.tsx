import type { ChecksStatus, PullRequestStatus, ReviewStatus, Thread } from "@shared/domain.ts"
import { useFocusEffect } from "expo-router"
import { useCallback } from "react"
import { StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale } from "@/components/motion"
import type { Tone } from "@/components/ui"
import { HIT, type Palette, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { type PullRequestSummary, pullRequestNumber, usePullRequests } from "@/stores/pull-requests"

export const statusGlyph = (theme: Palette): Record<PullRequestStatus, { name: IconName; color: string }> => ({
  open: { name: "RiGitPullRequestLine", color: theme.running },
  draft: { name: "RiGitPrDraftLine", color: theme.textMuted },
  // `link` is the violet that reads in both themes, where `primary` is too dark on black.
  merged: { name: "RiGitMergeLine", color: theme.link },
  closed: { name: "RiGitClosePullRequestLine", color: theme.danger },
})

export const statusLabel = (status: PullRequestStatus) => copy(`mobile_pr_state_${status}`)
export const statusTone: Record<PullRequestStatus, Tone> = {
  open: "running",
  draft: "neutral",
  merged: "neutral",
  closed: "danger",
}

export const checksLabel = (checks: ChecksStatus) => copy(`mobile_pr_checks_${checks}`)
export const checksTone: Record<ChecksStatus, Tone> = { passing: "running", failing: "danger", pending: "attention" }
export const checksIcon: Record<ChecksStatus, IconName> = {
  passing: "RiCheckLine",
  failing: "RiErrorWarningLine",
  pending: "RiLoader4Line",
}

const reviewKeys = {
  approved: "mobile_pr_review_approved",
  changesRequested: "mobile_pr_review_changes_requested",
  reviewRequired: "mobile_pr_review_required",
} as const
export const reviewLabel = (review: ReviewStatus) => copy(reviewKeys[review])
export const reviewTone: Record<ReviewStatus, Tone> = {
  approved: "running",
  changesRequested: "attention",
  reviewRequired: "neutral",
}

const checksDot = (theme: Palette, checks: ChecksStatus | null) =>
  checks === "failing" ? theme.danger : checks === "pending" ? theme.attention : null

/** "Pull request #123, Open, Checks failing" for screen readers. */
export function pullRequestLabel(number: string, summary: PullRequestSummary | null, more = 0) {
  const checks = summary?.checks ?? null
  return [
    copy("mobile_pr_number", { number }),
    summary !== null && statusLabel(summary.status),
    checks !== null && checksLabel(checks),
    more > 0 && copy("mobile_pr_more", { count: String(more) }),
  ]
    .filter((part) => typeof part === "string")
    .join(", ")
}

function useNewestPullRequest(threadId: string) {
  const links = usePullRequests((state) => state.linksByThread[threadId])
  const latest = links?.at(-1)
  const url = latest?.url ?? null
  const remote = usePullRequests((state) => (url === null ? undefined : state.summaries[url]))
  const generation = useConnection((state) => state.generation)
  // Checks and reviews change while a row sits on screen, so the summary is read again whenever the screen comes
  // back into view or the phone reconnects. `ensureSummary` skips reads younger than a minute.
  useFocusEffect(
    useCallback(() => {
      if (url !== null && generation > 0) usePullRequests.getState().ensureSummary(url)
    }, [url, generation]),
  )
  if (url === null || links === undefined) return null
  return {
    number: pullRequestNumber(url) ?? "?",
    summary: remote?.status === "ready" ? remote.value : null,
    more: links.length - 1,
  }
}

function PullRequestMark({
  number,
  summary,
  more,
}: {
  number: string
  summary: PullRequestSummary | null
  more: number
}) {
  const theme = useTheme()
  const glyph =
    summary === null
      ? { name: "RiGitPullRequestLine" as const, color: theme.textMuted }
      : statusGlyph(theme)[summary.status]
  const dot = checksDot(theme, summary?.checks ?? null)
  return (
    <View style={styles.mark}>
      <Icon name={glyph.name} size={13} color={glyph.color} />
      <Text style={[styles.number, { color: glyph.color }]}>#{number}</Text>
      {dot !== null && <View style={[styles.dot, { backgroundColor: dot }]} />}
      {more > 0 && <Text style={[styles.number, { color: theme.textMuted }]}>+{more}</Text>}
    </View>
  )
}

/** The newest pull request linked to a thread, as `#123` with its state, for a thread row. */
export function PullRequestBadge({ threadId }: { threadId: string }) {
  const newest = useNewestPullRequest(threadId)
  if (newest === null) return null
  return (
    <View accessible accessibilityLabel={pullRequestLabel(newest.number, newest.summary, newest.more)}>
      <PullRequestMark {...newest} />
    </View>
  )
}

const CHIP_HEIGHT = 26
const chipSlop = (HIT - CHIP_HEIGHT) / 2

/** The thread's pull request in the thread header. Pressing it opens the PRs tab. */
export function ThreadPullRequestChip({ thread, onPress }: { thread: Thread; onPress: () => void }) {
  const theme = useTheme()
  const newest = useNewestPullRequest(thread.id)
  if (newest === null) return null
  return (
    <PressableScale
      testID="thread-pull-request-chip"
      accessibilityRole="button"
      accessibilityLabel={pullRequestLabel(newest.number, newest.summary, newest.more)}
      hitSlop={{ top: chipSlop, bottom: chipSlop, left: 4, right: 4 }}
      onPress={onPress}
      style={[styles.chip, { borderColor: theme.border, backgroundColor: theme.surface }]}
    >
      <PullRequestMark {...newest} />
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  mark: { flexDirection: "row", alignItems: "center", gap: 3 },
  number: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  dot: { width: 6, height: 6, borderRadius: 3, marginLeft: 1 },
  chip: {
    height: CHIP_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
