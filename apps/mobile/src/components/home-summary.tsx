import { StyleSheet, Text, View } from "react-native"
import { RunningRail } from "@/components/running-rail"
import { WaitingSection } from "@/components/waiting-ticket"
import { useNow } from "@/hooks/use-now"
import { useShownServers } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { homeSummary, threadsWithRequests } from "@/lib/home-summary"
import { withinServers } from "@/lib/server-filter"
import { useMessages } from "@/stores/messages"
import { listedThreads, useThreads } from "@/stores/threads"

/** The day at a glance over the thread list: the counts, the threads that wait, then the ones that run. */
export function HomeOverview() {
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const requesting = useMessages((state) => threadsWithRequests(state.byThread))
  const servers = useShownServers()
  const now = useNow()
  const { threads } = withinServers(servers, projects, listedThreads(byId))
  const summary = homeSummary(threads, requesting, now)
  return (
    <>
      <DaySummary waiting={summary.waiting.length} running={summary.running.length} done={summary.doneToday} />
      {summary.waiting.length > 0 && <WaitingSection threads={summary.waiting} />}
      {summary.running.length > 0 && <RunningRail threads={summary.running} />}
    </>
  )
}

function DaySummary({ waiting, running, done }: { waiting: number; running: number; done: number }) {
  const theme = useTheme()
  const counts = [
    { label: copy("mobile_home_summary_waiting"), count: waiting, color: theme.attention },
    { label: copy("mobile_status_running"), count: running, color: theme.running },
    { label: copy("mobile_home_summary_done"), count: done, color: theme.text },
  ]
  return (
    <View
      testID="day-summary"
      accessible
      accessibilityRole="summary"
      accessibilityLabel={copy("mobile_home_summary", {
        waiting: String(waiting),
        running: String(running),
        done: String(done),
      })}
      style={[styles.summary, { borderColor: theme.border }]}
    >
      {counts.map((item, index) => (
        <View
          key={item.label}
          style={[
            styles.count,
            index === 0 ? styles.first : { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.number, { color: item.color }]}>{item.count}</Text>
          <Text numberOfLines={1} style={[styles.label, { color: theme.textMuted }]}>
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: "row",
    marginHorizontal: 8,
    marginTop: 4,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  count: { flex: 1, gap: 2, paddingHorizontal: 12 },
  first: { paddingLeft: 0 },
  number: { fontSize: 34, lineHeight: 40, fontWeight: "600", fontVariant: ["tabular-nums"] },
  label: { fontSize: 13 },
})
