import type { Thread } from "@shared/domain.ts"
import { router } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import Animated, { FadeIn, FadeOut } from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { StatusDot } from "@/components/motion"
import { PullRequestBadge } from "@/components/pull-request-badge"
import { type ThreadActionName, ThreadActionsSheet, useThreadActions } from "@/components/thread-actions"
import { providerMark } from "@/components/ui"
import { duration } from "@/constants/motion"
import { HIT, radius } from "@/constants/theme"
import { threadStatus } from "@/constants/thread-status"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { relativeTime } from "@/lib/relative-time"
import { useThreads } from "@/stores/threads"

export const rowEntering = FadeIn.duration(duration.fast)
export const rowExiting = FadeOut.duration(duration.fast)

/** Where a row sits in its rounded group, so the group's corners and separators line up. */
export interface GroupPosition {
  readonly first: boolean
  readonly last: boolean
}

export const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } })

/** A thread in a list. Tap opens it, long press offers pin and archive. */
export function ThreadRow({
  thread,
  showProject,
  position = { first: true, last: true },
}: {
  thread: Thread
  showProject: boolean
  position?: GroupPosition
}) {
  const theme = useTheme()
  const projectName = useThreads((state) => state.projects.find((project) => project.id === thread.projectId)?.name)
  const actions = useThreadActions(thread)
  const [actionsOpen, setActionsOpen] = useState(false)

  const title = thread.title || copy("mobile_home_untitled")
  const status = thread.status === "idle" ? null : threadStatus[thread.status].label
  const time = relativeTime(thread.updatedAt)
  const label = [title, projectName, thread.provider, status, time].filter(Boolean).join(", ")

  const runFromAccessibility = async (name: string) => {
    const action = actions.actions.find((candidate) => candidate.name === name)
    if (action !== undefined && !(await actions.run(action.name as ThreadActionName))) setActionsOpen(true)
  }

  return (
    <Animated.View entering={rowEntering} exiting={rowExiting}>
      <Pressable
        testID={`thread-row-${thread.id}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={copy("mobile_thread_actions_hint")}
        accessibilityActions={actions.actions.map((action) => ({ name: action.name, label: action.label }))}
        onAccessibilityAction={(event) => void runFromAccessibility(event.nativeEvent.actionName)}
        onPress={() => openThread(thread.id)}
        onLongPress={() => setActionsOpen(true)}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: pressed ? theme.surfaceStrong : theme.surface },
          position.first && styles.first,
          position.last && styles.last,
        ]}
      >
        <View style={styles.dot}>
          {thread.status === "running" && <StatusDot state="running" color={theme.running} />}
          {(thread.status === "awaiting_approval" || thread.status === "limited") && (
            <StatusDot state="attention" color={theme.attention} />
          )}
        </View>
        <View
          style={[
            styles.body,
            !position.first && { borderTopWidth: StyleSheet.hairlineWidth },
            { borderColor: theme.border },
          ]}
        >
          <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
            {title}
          </Text>
          <View style={styles.meta}>
            <Icon name={providerMark[thread.provider]} size={13} color={theme.textMuted} />
            {showProject && projectName !== undefined && (
              <Text numberOfLines={1} style={[styles.metaText, styles.project, { color: theme.textMuted }]}>
                {projectName}
              </Text>
            )}
            {status !== null && (
              <Text
                numberOfLines={1}
                style={[styles.metaText, { color: thread.status === "running" ? theme.running : theme.textMuted }]}
              >
                {status}
              </Text>
            )}
            <Text style={[styles.metaText, styles.time, { color: theme.textMuted }]}>{time}</Text>
            <PullRequestBadge threadId={thread.id} />
          </View>
        </View>
      </Pressable>
      <ThreadActionsSheet thread={thread} open={actionsOpen} onClose={() => setActionsOpen(false)} state={actions} />
    </Animated.View>
  )
}

export function SectionLabel({ label }: { label: string }) {
  const theme = useTheme()
  return (
    <Text accessibilityRole="header" style={[styles.sectionLabel, { color: theme.textMuted }]}>
      {label}
    </Text>
  )
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 13, fontWeight: "600", paddingHorizontal: 4, paddingTop: 16, paddingBottom: 6 },
  row: { minHeight: HIT + 16, flexDirection: "row", paddingLeft: 12 },
  first: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  last: { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md },
  dot: { width: 10, alignItems: "center", paddingTop: 19 },
  body: { flex: 1, gap: 4, paddingVertical: 12, paddingLeft: 10, paddingRight: 14 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "500" },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { fontSize: 13 },
  project: { flexShrink: 1 },
  time: { fontVariant: ["tabular-nums"] },
})
