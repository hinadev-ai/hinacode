import type { PullRequestLink } from "@shared/domain.ts"
import { checksIndicator, openChecks, type PullRequestAttention, pullRequestAttention } from "@shared/threadStatus.ts"
import { useFocusEffect } from "expo-router"
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from "react-native"
import { Icon } from "@/components/icon"
import { indicatorGlyph } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { statusGlyph } from "@/lib/pull-request-labels"
import { type PullRequestSummary, usePullRequests } from "@/stores/pull-requests"

export function usePullRequestSummary(url: string | null): PullRequestSummary | null {
  const remote = usePullRequests((state) => (url === null ? undefined : state.summaries[url]))
  const generation = useConnection((state) => state.generation)
  useFocusEffect(() => {
    if (url !== null && generation > 0) usePullRequests.getState().ensureSummary(url)
  })
  return remote?.status === "ready" ? remote.value : null
}

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
  useFocusEffect(() => {
    if (generation === 0) return
    for (const link of links) usePullRequests.getState().ensureSummary(link.url)
  })
  return attention
}

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
