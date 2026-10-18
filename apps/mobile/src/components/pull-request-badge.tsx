import type { Thread } from "@shared/domain.ts"
import { useFocusEffect } from "expo-router"
import { useCallback } from "react"
import { StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { PressableScale } from "@/components/motion"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { checksDot, pullRequestLabel, statusGlyph } from "@/lib/pull-request-labels"
import { type PullRequestSummary, pullRequestNumber, usePullRequests } from "@/stores/pull-requests"

function useNewestPullRequest(threadId: string) {
  const links = usePullRequests((state) => state.linksByThread[threadId])
  const latest = links?.at(-1)
  const url = latest?.url ?? null
  const remote = usePullRequests((state) => (url === null ? undefined : state.summaries[url]))
  const generation = useConnection((state) => state.generation)
  // Checks and reviews change while the thread is open, so the summary is read again whenever the screen comes
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
