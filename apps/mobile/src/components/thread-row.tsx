import { pullRequestNumberLabelOfUrl } from "@shared/codeHost.ts"
import type { PullRequestLink, Thread } from "@shared/domain.ts"
import { openChecks, type RowState, rowEmphasis, rowState, rowStatusIndicator } from "@shared/threadStatus.ts"
import { StyleSheet, Text, View } from "react-native"
import Animated from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { AttentionRing } from "@/components/motion"
import { ServerMark, serverLabel } from "@/components/server-mark"
import { ProjectIcon } from "@/components/project-icon"
import { PullRequestMark, usePullRequestAttention, usePullRequestSummary } from "@/components/pull-request-badge"
import { ThreadActionsTarget } from "@/components/thread-actions"
import { ProviderMark } from "@/components/ui"
import type { listEntering, listExiting } from "@/constants/motion"
import { indicatorGlyph, mono, radius, subheading, type Palette } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useProjectServer, useSeveralServers } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { checksLabel, statusLabel as pullRequestStatusLabel } from "@/lib/pull-request-labels"
import { relativeTime } from "@/lib/relative-time"
import { usePullRequests } from "@/stores/pull-requests"
import { threadBranch, useThreads } from "@/stores/threads"
import { useUnseen } from "@/stores/unseen"

const MARK_SIZE = 16
const MARK_GAP = 10
const STATUS_SIZE = 16
const noLinks: readonly PullRequestLink[] = []
const PHONE_RECEIVES_BACKGROUND_TASKS = false

const titleColor = (theme: Palette, state: RowState, away: boolean) => {
  if (away) return theme.textMuted
  switch (rowEmphasis[state]) {
    case "attention":
      return theme.text
    case "resting":
      return theme.textResting
    case "working":
      return theme.textMuted
  }
}

type IndicatedState = keyof typeof rowStatusIndicator

const statusLabel: Record<IndicatedState, string> = {
  running: copy("mobile_status_running"),
  background: copy("mobile_status_background"),
  awaiting_approval: copy("mobile_status_awaiting"),
  limited: copy("mobile_status_limited"),
  interrupted: copy("mobile_status_interrupted"),
  unseen_completed: copy("mobile_status_unseen_completed"),
  unseen_failed: copy("mobile_status_unseen_failed"),
  pr_conflicting: copy("mobile_status_pr_conflicting"),
  pr_checksFailing: copy("mobile_status_pr_checks_failing"),
  pr_changesRequested: copy("mobile_status_pr_changes_requested"),
}

const isIndicated = (state: RowState): state is IndicatedState => state in rowStatusIndicator

export function ThreadRow({
  thread,
  showProject,
  entering,
  exiting,
}: {
  thread: Thread
  showProject: boolean
  entering?: typeof listEntering
  exiting?: typeof listExiting
}) {
  const theme = useTheme()
  const now = useNow()
  const project = useThreads((threads) =>
    showProject ? threads.projects.find((candidate) => candidate.id === thread.projectId)?.name : undefined,
  )
  const worktree = useThreads((threads) =>
    thread.worktreeId === null ? undefined : threads.worktrees[thread.worktreeId],
  )
  const rootBranch = useThreads((threads) => threads.branches[thread.projectId])
  const branch = threadBranch(worktree, rootBranch)
  const links = usePullRequests((pullRequests) => pullRequests.linksByThread[thread.id]) ?? noLinks
  const state = rowState(
    thread,
    PHONE_RECEIVES_BACKGROUND_TASKS,
    useUnseen((unseen) => unseen.byThreadId[thread.id]),
    usePullRequestAttention(links),
  )
  const latest = links.at(-1)
  const number = latest === undefined ? null : pullRequestNumberLabelOfUrl(latest.url)
  const summary = usePullRequestSummary(latest?.url ?? null)
  const checks = openChecks(summary ?? undefined)
  const watching = links.some((link) => link.watch !== null)
  const server = useProjectServer(thread.projectId)
  const away = server !== undefined && server.status !== "connected"
  const several = useSeveralServers()

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
    isIndicated(state) && statusLabel[state],
    pullRequest,
    pullRequest !== undefined && summary !== null && pullRequestStatusLabel(summary.status),
    pullRequest !== undefined && checks !== null && checksLabel(checks),
    watching && copy("mobile_row_watching"),
    time,
  ]
    .filter((part) => typeof part === "string" && part !== "")
    .join(", ")

  return (
    <Animated.View entering={entering} exiting={exiting}>
      <ThreadActionsTarget thread={thread} testID={`thread-row-${thread.id}`} accessibilityLabel={label}>
        {(pressed) => (
        <View style={[styles.row, pressed && { backgroundColor: theme.surface }]}>
          {project !== undefined && (
            <View style={styles.projectLine}>
              <ProjectIcon projectId={thread.projectId} size={12} />
              <Text numberOfLines={1} style={[styles.meta, styles.project, { color: theme.textMuted }]}>
                {project}
              </Text>
            </View>
          )}
          <View style={styles.titleLine}>
            <Text numberOfLines={1} style={[styles.title, { color: titleColor(theme, state, away) }]}>
              {title}
            </Text>
            <ProviderMark provider={thread.provider} size={MARK_SIZE} />
            {isIndicated(state) && <StatusIndicator state={state} />}
          </View>
          <View style={styles.metaLine}>
            <ServerMark server={showProject ? server : undefined} />
            {branch !== null && (
              <View style={styles.branch}>
                <Icon name="Branch" size={12} color={theme.textMuted} />
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
                <PullRequestMark
                  number={number}
                  summary={summary}
                  stacked={links.length > 1}
                  size={12}
                  textStyle={[styles.meta, styles.mono]}
                />
              </View>
            )}
            {watching && <Icon name="Eye" size={12} color={theme.textMuted} />}
            <Text style={[styles.meta, styles.time, { color: theme.textMuted }]}>{time}</Text>
          </View>
        </View>
        )}
      </ThreadActionsTarget>
    </Animated.View>
  )
}

function StatusIndicator({ state }: { state: IndicatedState }) {
  const theme = useTheme()
  const glyph = indicatorGlyph(theme, rowStatusIndicator[state])
  return (
    <View style={styles.status}>
      <Icon {...glyph} size={STATUS_SIZE} />
      {state === "awaiting_approval" && <AttentionRing color={glyph.color} />}
    </View>
  )
}

export function SectionLabel({ label }: { label: string }) {
  const theme = useTheme()
  return (
    <Text accessibilityRole="header" {...subheading} style={[styles.sectionLabel, { color: theme.textMuted }]}>
      {label}
    </Text>
  )
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 13, fontWeight: "500", paddingHorizontal: 10, paddingTop: 12, paddingBottom: 4 },
  row: { borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: MARK_GAP, minHeight: 22 },
  title: { flex: 1, fontSize: 16, lineHeight: 22 },
  metaLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 18 },
  meta: { fontSize: 12, lineHeight: 18 },
  mono: { fontFamily: mono },
  projectLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  project: { flexShrink: 1 },
  branch: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
  removed: { textDecorationLine: "line-through" },
  pullRequest: { flexShrink: 0 },
  time: { marginLeft: "auto", paddingLeft: 4, flexShrink: 0, fontVariant: ["tabular-nums"] },
  status: { width: STATUS_SIZE, height: STATUS_SIZE },
})
