import type { PullRequestLink } from "@shared/domain.ts"
import { checksIndicator, openChecks, type PullRequestAttention, pullRequestAttention } from "@shared/threadStatus.ts"
import { useFocusEffect } from "expo-router"
import { useCallback } from "react"
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from "react-native"
import { Icon } from "@/components/icon"
import { indicatorGlyph } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { statusGlyph } from "@/lib/pull-request-labels"
import { type PullRequestSummary, usePullRequests } from "@/stores/pull-requests"

/**
 * The state of the pull request at `url`, or null until GitHub answers. Checks and reviews change while the
 * developer looks, so it is read again whenever the screen comes back into view or the phone reconnects.
 * `ensureSummary` skips reads younger than a minute.
 */
export function usePullRequestSummary(url: string | null): PullRequestSummary | null {
  const remote = usePullRequests((state) => (url === null ? undefined : state.summaries[url]))
  const generation = useConnection((state) => state.generation)
  useFocusEffect(
    useCallback(() => {
      if (url !== null && generation > 0) usePullRequests.getState().ensureSummary(url)
    }, [url, generation]),
  )
  return remote?.status === "ready" ? remote.value : null
}

/**
 * The most urgent reason any of `links` waits on the developer, read again like `usePullRequestSummary`. The row
 * only re-renders when that reason changes, not on every summary a read writes.
 */
export function usePullRequestAttention(links: readonly PullRequestLink[]): PullRequestAttention | undefined {
  const attention = usePullRequests((state) =>
    pullRequestAttention(
      links.map((link) => {
        const remote = state.summaries[link.url]
        return remote?.status === "ready" ? remote.value : undefined
      }),
    ),
  )
  const generation = useConnection((state) => state.generation)
  useFocusEffect(
    useCallback(() => {
      if (generation === 0) return
      for (const link of links) usePullRequests.getState().ensureSummary(link.url)
    }, [links, generation]),
  )
  return attention
}

/**
 * A pull request number in its state's color, as in the desktop sidebar: a stack when the thread linked several,
 * the state's icon, and the checks while the pull request is still open. Before the state loads, a muted icon.
 */
export function PullRequestMark({
  number,
  summary,
  stacked = false,
  size,
  textStyle,
}: {
  number: string
  summary: PullRequestSummary | null
  stacked?: boolean
  size: number
  textStyle: StyleProp<TextStyle>
}) {
  const theme = useTheme()
  const status =
    summary === null
      ? { name: "RiGitPullRequestLine" as const, color: theme.textMuted }
      : statusGlyph(theme)[summary.status]
  const checks = openChecks(summary ?? undefined)
  return (
    <View style={styles.mark}>
      {stacked && <Icon name="Stack" size={size} color={status.color} />}
      <Icon name={status.name} size={size} color={status.color} />
      <Text style={[textStyle, { color: status.color }]}>#{number}</Text>
      {checks !== null && (
        <View style={styles.checks}>
          <Icon {...indicatorGlyph(theme, checksIndicator[checks])} size={size} />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  mark: { flexDirection: "row", alignItems: "center", gap: 2 },
  checks: { marginLeft: 2 },
})
