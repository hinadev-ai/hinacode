import { useAtomMount } from "@effect/atom-react"
import type { Thread } from "@shared/domain.ts"
import { useFocusEffect } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { Spinner } from "@/components/motion"
import { ApprovalCard, QuestionCard } from "@/components/request-cards"
import { mono, radius, subheading } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { openRequests } from "@/lib/home-summary"
import { openThread } from "@/lib/navigation"
import { relativeTime } from "@/lib/relative-time"
import { loadHistoryAtom, useMessages } from "@/stores/messages"
import { useThreadBranchName, useThreads } from "@/stores/threads"

const MAX_TICKETS = 5
const TEAR_DOT = 3
const TEAR_GAP = 7

export function WaitingSection({ threads }: { threads: readonly Thread[] }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" {...subheading} style={[styles.heading, { color: theme.text }]}>
        {copy("mobile_home_summary_waiting")}
      </Text>
      {(expanded ? threads : threads.slice(0, MAX_TICKETS)).map((thread) => (
        <WaitingTicket key={thread.id} thread={thread} />
      ))}
      {!expanded && threads.length > MAX_TICKETS && (
        <Pressable
          testID="waiting-show-all"
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [styles.showAll, pressed && { backgroundColor: theme.surface }]}
        >
          <Text style={[styles.showAllLabel, { color: theme.primary }]}>{copy("mobile_home_show_all")}</Text>
          <Icon name="ChevronRight" size={16} color={theme.primary} />
        </Pressable>
      )}
    </View>
  )
}

function WaitingTicket({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const history = useMessages((state) => state.byThread[thread.id])
  // FIXME: NativeTabs keeps a hidden tab mounted, so the transcript is watched only while the Threads tab shows.
  useFocusEffect(() => useMessages.getState().watch(thread.id))
  useAtomMount(loadHistoryAtom(thread.id))

  const requests = openRequests(history)
  const first = requests[0]
  const header = <TicketHeader thread={thread} />
  if (first === undefined)
    return (
      <View testID="waiting-ticket" style={[styles.bare, { borderColor: theme.border, backgroundColor: theme.card }]}>
        {header}
        {history === undefined || history.status === "loading" ? (
          <View accessibilityLabel={copy("mobile_home_loading_request")} style={styles.status}>
            <Spinner size={16} color={theme.textMuted} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy("mobile_home_open_ticket", { title: thread.title || copy("mobile_home_untitled") })}
            onPress={() => openThread(thread.id)}
            style={({ pressed }) => [styles.status, pressed && styles.pressed]}
          >
            <Text style={[styles.open, { color: theme.primary }]}>{copy("mobile_home_open")}</Text>
            <Icon name="ChevronRight" size={16} color={theme.primary} />
          </Pressable>
        )}
      </View>
    )

  return (
    <View testID="waiting-ticket" style={styles.ticket}>
      {first.kind === "approval" ? (
        <ApprovalCard key={first.request.id} request={first.request} header={header} since={thread.updatedAt} />
      ) : (
        <QuestionCard key={first.request.id} request={first.request} header={header} since={thread.updatedAt} />
      )}
      {requests.length > 1 && (
        <Text style={[styles.more, { color: theme.textMuted }]}>
          {copy("mobile_home_more_requests", { count: String(requests.length - 1) })}
        </Text>
      )}
    </View>
  )
}

function TicketHeader({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const now = useNow()
  const project = useThreads((state) => state.projects.find((candidate) => candidate.id === thread.projectId)?.name)
  const branch = useThreadBranchName(thread)
  const title = thread.title || copy("mobile_home_untitled")
  const age = relativeTime(thread.updatedAt, now)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy("mobile_home_open_ticket", { title })}
      accessibilityHint={[project, branch, age].filter((part) => part !== undefined).join(", ")}
      onPress={() => openThread(thread.id)}
      style={({ pressed }) => [styles.header, pressed && styles.pressed]}
    >
      <View style={styles.meta}>
        <Text numberOfLines={1} style={[styles.where, { color: theme.textMuted }]}>
          {project}
          {branch !== undefined && <Text style={styles.mono}>{` · ${branch}`}</Text>}
        </Text>
        <Icon name="Clock" size={14} color={theme.attention} />
        <Text style={[styles.age, { color: theme.attention }]}>{age}</Text>
      </View>
      <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
        {title}
      </Text>
      <TearLine />
    </Pressable>
  )
}

function TearLine() {
  const theme = useTheme()
  const [width, setWidth] = useState(0)
  const count = Math.max(0, Math.floor((width + TEAR_GAP) / (TEAR_DOT + TEAR_GAP)))
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.tear}
    >
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[styles.tearDot, { backgroundColor: theme.border }]} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  section: { gap: 12, paddingHorizontal: 8, paddingTop: 20 },
  heading: { fontSize: 17, fontWeight: "600" },
  ticket: { gap: 6 },
  bare: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 10 },
  header: { gap: 6 },
  pressed: { opacity: 0.7 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  where: { flex: 1, fontSize: 13 },
  mono: { fontFamily: mono },
  age: { fontFamily: mono, fontSize: 13, fontVariant: ["tabular-nums"] },
  title: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  tear: { height: TEAR_DOT, flexDirection: "row", justifyContent: "space-between", marginTop: 6, overflow: "hidden" },
  tearDot: { width: TEAR_DOT, height: TEAR_DOT, borderRadius: radius.full },
  status: { minHeight: 32, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 },
  open: { fontSize: 15, fontWeight: "600" },
  more: { fontSize: 13, paddingHorizontal: 4 },
  showAll: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderRadius: radius.md,
  },
  showAllLabel: { fontSize: 15, fontWeight: "600" },
})
