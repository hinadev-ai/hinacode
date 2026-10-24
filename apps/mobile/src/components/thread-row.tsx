import type { PullRequestLink, Thread } from "@shared/domain.ts"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import Animated from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { StatusDot } from "@/components/motion"
import { ServerMark, serverLabel } from "@/components/server-mark"
import { ThreadActionsSheet, useThreadActions } from "@/components/thread-actions"
import { ProviderMark } from "@/components/ui"
import { listEntering, listExiting } from "@/constants/motion"
import { mono, type Palette, radius } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useProjectServer, useSeveralServers } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { openThread } from "@/lib/navigation"
import { relativeTime } from "@/lib/relative-time"
import { type RowState, rowEmphasis, rowState } from "@/lib/row-state"
import type { ThreadActionName } from "@/lib/thread-actions"
import { pullRequestNumber, usePullRequests } from "@/stores/pull-requests"
import { threadBranch, useThreads } from "@/stores/threads"
import { useUnseen } from "@/stores/unseen"

const MARK_SIZE = 16
const MARK_GAP = 10
const noLinks: readonly PullRequestLink[] = []

const titleColor = (theme: Palette, state: RowState) => {
  switch (rowEmphasis[state]) {
    case "attention":
      return theme.text
    case "resting":
      return theme.textResting
    case "working":
      return theme.textMuted
  }
}

const stateLabel: Partial<Record<RowState, string>> = {
  running: copy("mobile_status_running"),
  awaiting_approval: copy("mobile_status_awaiting"),
  limited: copy("mobile_status_limited"),
  archived: copy("mobile_status_archived"),
  unseen_completed: copy("mobile_status_unseen_completed"),
  unseen_failed: copy("mobile_status_unseen_failed"),
}

/**
 * A thread in a list, laid out like a desktop sidebar row: the agent's mark, the title and its status, then the
 * project, branch, pull request and last activity. Tap opens it, long press offers pin and archive.
 */
export function ThreadRow({ thread, showProject }: { thread: Thread; showProject: boolean }) {
  const theme = useTheme()
  const now = useNow()
  const state = rowState(
    thread.status,
    useUnseen((unseen) => unseen.byThreadId[thread.id]),
  )
  const project = useThreads((threads) =>
    showProject ? threads.projects.find((candidate) => candidate.id === thread.projectId)?.name : undefined,
  )
  const worktree = useThreads((threads) =>
    thread.worktreeId === null ? undefined : threads.worktrees[thread.worktreeId],
  )
  const rootBranch = useThreads((threads) => threads.branches[thread.projectId])
  const branch = threadBranch(worktree, rootBranch)
  const links = usePullRequests((pullRequests) => pullRequests.linksByThread[thread.id]) ?? noLinks
  const latest = links.at(-1)
  const number = latest === undefined ? null : pullRequestNumber(latest.url)
  const watching = links.some((link) => link.watch !== null)
  const actions = useThreadActions(thread)
  const server = useProjectServer(thread.projectId)
  const away = server !== undefined && server.status !== "connected"
  const several = useSeveralServers()
  const [actionsOpen, setActionsOpen] = useState(false)

  const title = thread.title || copy("mobile_home_untitled")
  const time = relativeTime(thread.updatedAt, now)
  const pullRequest =
    number === null
      ? undefined
      : links.length > 1
        ? copy("mobile_row_pull_request_stack", { number, count: String(links.length) })
        : copy("mobile_row_pull_request", { number })
  const label = [
    title,
    several && server !== undefined && serverLabel(server),
    project,
    branch && copy("mobile_row_branch", { branch: branch.name }),
    stateLabel[state],
    pullRequest,
    watching && copy("mobile_row_watching"),
    time,
  ]
    .filter((part) => typeof part === "string" && part !== "")
    .join(", ")

  const runFromAccessibility = async (name: string) => {
    const action = actions.actions.find((candidate) => candidate.name === name)
    if (action !== undefined && !(await actions.run(action.name as ThreadActionName))) setActionsOpen(true)
  }

  return (
    <Animated.View entering={listEntering} exiting={listExiting}>
      <Pressable
        testID={`thread-row-${thread.id}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={copy("mobile_thread_actions_hint")}
        accessibilityActions={actions.actions.map((action) => ({ name: action.name, label: action.label }))}
        onAccessibilityAction={(event) => void runFromAccessibility(event.nativeEvent.actionName)}
        onPress={() => openThread(thread.id)}
        onLongPress={() => setActionsOpen(true)}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }, away && styles.away]}
      >
        <View style={styles.titleLine}>
          <ProviderMark provider={thread.provider} size={MARK_SIZE} />
          <Text numberOfLines={1} style={[styles.title, { color: titleColor(theme, state) }]}>
            {title}
          </Text>
          <StatusIndicator state={state} />
        </View>
        <View style={styles.metaLine}>
          <ServerMark server={showProject ? server : undefined} />
          {project !== undefined && (
            <Text numberOfLines={1} style={[styles.meta, styles.project, { color: theme.textMuted }]}>
              {project}
            </Text>
          )}
          {branch !== null && (
            <View style={styles.branch}>
              <Icon name="RiGitBranchLine" size={12} color={theme.textMuted} />
              <Text
                numberOfLines={1}
                style={[styles.meta, styles.mono, { color: theme.textMuted }, branch.removed && styles.removed]}
              >
                {branch.name}
              </Text>
            </View>
          )}
          {number !== null && (
            <View style={styles.pullRequest}>
              {links.length > 1 && <Icon name="RiStackLine" size={12} color={theme.textMuted} />}
              <Text style={[styles.meta, styles.mono, { color: theme.textMuted }]}>#{number}</Text>
            </View>
          )}
          {watching && <Icon name="RiEyeLine" size={12} color={theme.textMuted} />}
          <Text style={[styles.meta, styles.time, { color: theme.textMuted }]}>{time}</Text>
        </View>
      </Pressable>
      <ThreadActionsSheet thread={thread} open={actionsOpen} onClose={() => setActionsOpen(false)} state={actions} />
    </Animated.View>
  )
}

/** A running dot pulses, a request rings, a usage limit names itself, and an unopened result waits as a dot. */
function StatusIndicator({ state }: { state: RowState }) {
  const theme = useTheme()
  switch (state) {
    case "running":
      return <StatusDot state="running" color={theme.running} />
    case "awaiting_approval":
      return <StatusDot state="attention" color={theme.attention} />
    case "limited":
      return (
        <View style={[styles.limited, { backgroundColor: theme.attentionBg }]}>
          <Icon name="RiErrorWarningLine" size={12} color={theme.attention} />
          <Text style={[styles.limitedLabel, { color: theme.attention }]}>{copy("mobile_status_limited")}</Text>
        </View>
      )
    case "unseen_completed":
      return <View style={[styles.dot, { backgroundColor: theme.text }]} />
    case "unseen_failed":
      return <Icon name="RiErrorWarningFill" size={14} color={theme.danger} />
    default:
      return null
  }
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
  sectionLabel: { fontSize: 13, fontWeight: "500", paddingHorizontal: 10, paddingTop: 12, paddingBottom: 4 },
  row: { borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: MARK_GAP, minHeight: 22 },
  title: { flex: 1, fontSize: 16, lineHeight: 22 },
  metaLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 18, paddingLeft: MARK_SIZE + MARK_GAP },
  meta: { fontSize: 13, lineHeight: 18 },
  mono: { fontFamily: mono },
  project: { flexShrink: 0, maxWidth: "50%" },
  branch: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
  removed: { textDecorationLine: "line-through" },
  pullRequest: { flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 },
  time: { marginLeft: "auto", paddingLeft: 4, flexShrink: 0, fontVariant: ["tabular-nums"] },
  away: { opacity: 0.5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  limited: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  limitedLabel: { fontSize: 12, fontWeight: "500" },
})
