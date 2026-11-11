import type { Thread } from "@shared/domain.ts"
import { useIsFocused } from "expo-router"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { PressableScale, Spinner } from "@/components/motion"
import { mono, radius, subheading } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { stopwatch } from "@/lib/home-summary"
import { openThread } from "@/lib/navigation"
import { useThreadBranchName, useThreads } from "@/stores/threads"

const CARD_WIDTH = 200

export function RunningRail({ threads }: { threads: readonly Thread[] }) {
  const theme = useTheme()
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" {...subheading} style={[styles.heading, { color: theme.text }]}>
        {copy("mobile_status_running")}
      </Text>
      <ScrollView
        testID="running-rail"
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.bleed}
        contentContainerStyle={styles.rail}
      >
        {threads.map((thread) => (
          <RunningCard key={thread.id} thread={thread} />
        ))}
      </ScrollView>
    </View>
  )
}

function RunningCard({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const now = useNow(1000, { paused: !useIsFocused() })
  const since = useThreads((state) => state.runningSince[thread.id]) ?? thread.updatedAt
  const branch = useThreadBranchName(thread)
  const title = thread.title || copy("mobile_home_untitled")
  const elapsed = stopwatch(now - Date.parse(since))
  return (
    <PressableScale
      testID="running-card"
      accessibilityRole="button"
      accessibilityLabel={copy("mobile_home_running_card", { title, time: elapsed })}
      accessibilityHint={branch}
      onPress={() => openThread(thread.id)}
      style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
    >
      <View style={styles.timer}>
        <Spinner size={16} color={theme.running} />
        <Text style={[styles.elapsed, { color: theme.running }]}>{elapsed}</Text>
      </View>
      <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
        {title}
      </Text>
      {branch !== undefined && (
        <Text numberOfLines={1} style={[styles.branch, { color: theme.textMuted }]}>
          {branch}
        </Text>
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  section: { gap: 12, paddingTop: 20 },
  heading: { fontSize: 17, fontWeight: "600", paddingHorizontal: 8 },
  bleed: { marginHorizontal: -8 },
  rail: { gap: 10, paddingHorizontal: 16 },
  card: { width: CARD_WIDTH, gap: 8, padding: 14, borderWidth: 1, borderRadius: radius.lg },
  timer: { flexDirection: "row", alignItems: "center", gap: 8 },
  elapsed: { fontFamily: mono, fontSize: 24, fontWeight: "600", fontVariant: ["tabular-nums"] },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  branch: { fontFamily: mono, fontSize: 12 },
})
