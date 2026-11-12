import { codeHostName, codeHostOfUrl } from "@shared/codeHost.ts"
import type { LinearIssue } from "@shared/domain.ts"
import { router, useFocusEffect } from "expo-router"
import { useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { GroupedCard, SectionHeading } from "@/components/grouped-card"
import { Icon, type IconName } from "@/components/icon"
import { Reveal, Spinner } from "@/components/motion"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { Button, EmptyState, Notice } from "@/components/ui"
import { CalloutColors, HIT, mono, type Palette, READABLE_WIDTH } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { openWebUrl } from "@/lib/open-url"
import {
  issueDraft,
  type OverviewPullRequest,
  type PullRequestNeed,
  type PullRequestProgress,
  pullRequestOverview,
  pullRequestReference,
} from "@/lib/overview"
import { checksLabel, reviewLabel, statusGlyph, statusLabel } from "@/lib/pull-request-labels"
import { useLinear } from "@/stores/linear"
import { usePullRequests } from "@/stores/pull-requests"
import { useThreads } from "@/stores/threads"

const PULL_REQUEST_READS = 4

async function readPullRequests(urls: readonly string[], force: boolean) {
  const queue = [...urls]
  const { loadPullRequest } = usePullRequests.getState()
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) await loadPullRequest(url, { force })
  }
  await Promise.all(Array.from({ length: PULL_REQUEST_READS }, worker))
}

function useReadOnFocus(connected: boolean, urls: string) {
  useFocusEffect(() => {
    if (!connected) return
    void readPullRequests(urls === "" ? [] : urls.split("\n"), false)
    void useLinear.getState().load()
  })
}

export default function PullRequestsScreen() {
  const theme = useTheme()
  const now = useNow()
  const connected = useConnection((state) => state.status === "connected")
  const linksByThread = usePullRequests((state) => state.linksByThread)
  const pullRequests = usePullRequests((state) => state.pullRequests)
  const threads = useThreads((state) => state.byId)
  const [refreshing, setRefreshing] = useState(false)
  const [issue, setIssue] = useState<LinearIssue | null>(null)

  const overview = pullRequestOverview(Object.values(linksByThread).flat(), threads, pullRequests, now)
  useReadOnFocus(connected, overview.urls.join("\n"))

  const refresh = () => {
    setRefreshing(true)
    return Promise.all([
      usePullRequests.getState().load(),
      readPullRequests(overview.urls, true),
      useLinear.getState().load({ force: true }),
    ]).finally(() => setRefreshing(false))
  }

  const groups = [
    { label: copy("mobile_overview_needs_you"), rows: overview.attention },
    { label: copy("mobile_overview_open"), rows: overview.open },
    { label: copy("mobile_overview_merged_today"), rows: overview.mergedToday },
    { label: copy("mobile_overview_merged"), rows: overview.merged },
    { label: copy("mobile_overview_unknown"), rows: overview.unknown },
  ].filter((group) => group.rows.length > 0)

  return (
    <>
      <ScrollView
        testID="overview"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.page}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            enabled={connected}
            onRefresh={() => void refresh()}
            tintColor={theme.textMuted}
          />
        }
      >
        <View style={styles.column}>
          {!connected && <Notice text={copy("mobile_overview_offline")} />}
          {groups.length === 0 ? (
            <EmptyState
              icon="RiGitPullRequestLine"
              title={copy("mobile_overview_pull_requests_empty")}
              hint={copy("mobile_overview_pull_requests_empty_hint")}
            />
          ) : (
            groups.map((group) => (
              <View key={group.label}>
                <SectionHeading label={group.label} count={group.rows.length} />
                <GroupedCard>
                  {group.rows.map((row) => (
                    <PullRequestRow key={row.url} row={row} />
                  ))}
                </GroupedCard>
              </View>
            ))
          )}
          <LinearIssues connected={connected} onPick={setIssue} />
        </View>
      </ScrollView>
      <NewThreadSheet
        open={issue !== null}
        onClose={() => setIssue(null)}
        title={issue?.identifier}
        header={issue !== null && <IssueHeader issue={issue} />}
        draft={issue === null ? undefined : issueDraft(issue)}
      />
    </>
  )
}

type ProgressLine = { label: string; color: string; icon: IconName }

const progressLine = (theme: Palette, pending: string): Record<PullRequestProgress, ProgressLine> => ({
  conflicts: { label: copy("mobile_pr_conflicting"), color: theme.danger, icon: "Warning" },
  checksFailing: { label: checksLabel("failing"), color: theme.danger, icon: "Warning" },
  changesRequested: { label: reviewLabel("changesRequested"), color: theme.attention, icon: "Chat" },
  checksRunning: { label: checksLabel("pending"), color: pending, icon: "Spinner" },
  reviewRequired: { label: reviewLabel("reviewRequired"), color: theme.textMuted, icon: "Eye" },
  readyToMerge: { label: copy("mobile_pr_ready_to_merge"), color: theme.running, icon: "Check" },
})

const needLabel: Record<PullRequestNeed, () => string> = {
  checks: () => checksLabel("failing"),
  changes: () => reviewLabel("changesRequested"),
  conflicts: () => copy("mobile_pr_conflicting"),
}

function PullRequestRow({ row }: { row: OverviewPullRequest }) {
  const theme = useTheme()
  const pending = CalloutColors[useScheme()].note.ink
  const thread = useThreads((state) => state.byId[row.threadId])
  const { pullRequest } = row
  const reference = pullRequestReference(row.url)
  const glyph =
    pullRequest !== null
      ? statusGlyph(theme)[pullRequest.status]
      : row.error !== null
        ? { name: "Warning" as const, color: theme.danger }
        : { name: "RiGitPullRequestLine" as const, color: theme.textMuted }
  const progress = row.progress === null ? null : progressLine(theme, pending)[row.progress]

  const label = [
    pullRequest?.title,
    reference,
    pullRequest !== null && statusLabel(pullRequest.status),
    progress?.label,
    ...row.needs.map((need) => needLabel[need]()).filter((need) => need !== progress?.label),
    row.error !== null && copy("mobile_pr_card_failed", { message: row.error }),
    thread?.title,
  ]
    .filter((part) => typeof part === "string")
    .join(", ")

  return (
    <Pressable
      testID="overview-pull-request"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push({ pathname: "/thread/[id]/pull-request", params: { id: row.threadId, url: row.url } })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <View style={styles.rowIcon}>
        <Icon {...glyph} size={18} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.titleLine}>
          <Text numberOfLines={2} style={[styles.title, { color: pullRequest === null ? theme.textMuted : theme.text }]}>
            {pullRequest?.title ?? reference}
          </Text>
          {pullRequest === null && row.error === null && (
            <Reveal>
              <Spinner size={14} color={theme.textMuted} />
            </Reveal>
          )}
        </View>
        <View style={styles.meta}>
          {pullRequest !== null && (
            <Text numberOfLines={1} style={[styles.metaText, styles.reference, { color: theme.textMuted }]}>
              {reference}
            </Text>
          )}
          {pullRequest !== null && thread !== undefined && (
            <Text style={[styles.metaText, { color: theme.textMuted }]}>·</Text>
          )}
          {thread !== undefined && (
            <View style={styles.thread}>
              <Icon name="Chat" size={13} color={theme.textMuted} />
              <Text numberOfLines={1} style={[styles.metaText, styles.threadTitle, { color: theme.textMuted }]}>
                {thread.title || copy("mobile_home_untitled")}
              </Text>
            </View>
          )}
        </View>
        {progress !== null && (
          <View style={styles.progress}>
            {progress.icon === "Spinner" ? (
              <Spinner size={14} color={progress.color} />
            ) : (
              <Icon name={progress.icon} size={14} color={progress.color} />
            )}
            <Text numberOfLines={1} style={[styles.progressLabel, { color: progress.color }]}>
              {progress.label}
            </Text>
          </View>
        )}
        {row.error !== null && (
          <Text numberOfLines={1} style={[styles.metaText, { color: theme.textMuted }]}>
            {copy("mobile_pr_lookup_failed", { host: codeHostName(codeHostOfUrl(row.url)) })}
          </Text>
        )}
      </View>
    </Pressable>
  )
}

function LinearIssues({ connected, onPick }: { connected: boolean; onPick: (issue: LinearIssue) => void }) {
  const issues = useLinear((state) => state.issues)
  const count = issues?.status === "ready" && issues.value.length > 0 ? issues.value.length : undefined
  if (!connected && (issues === undefined || issues.status === "loading")) return null
  return (
    <View>
      <SectionHeading label={copy("mobile_overview_linear")} count={count} />
      <LinearIssueList connected={connected} onPick={onPick} />
    </View>
  )
}

function LinearIssueList({ connected, onPick }: { connected: boolean; onPick: (issue: LinearIssue) => void }) {
  const theme = useTheme()
  const issues = useLinear((state) => state.issues)
  const configured = useLinear((state) => state.configured)

  if (issues === undefined || issues.status === "loading") {
    return (
      <Reveal style={styles.loading}>
        <Spinner color={theme.textMuted} />
        <Text style={{ color: theme.textMuted }}>{copy("mobile_overview_linear_loading")}</Text>
      </Reveal>
    )
  }
  if (issues.status === "error")
    return (
      <View style={styles.failed}>
        <Notice tone="danger" text={issues.message} />
        {connected && (
          <Button
            label={copy("mobile_home_retry")}
            icon="Refresh"
            style={styles.retry}
            onPress={() => void useLinear.getState().load({ force: true })}
          />
        )}
      </View>
    )
  if (issues.value.length === 0)
    return configured === false ? (
      <EmptyState
        icon="RiTaskLine"
        title={copy("mobile_overview_linear_not_connected")}
        hint={copy("mobile_overview_linear_connect_hint")}
      />
    ) : (
      <EmptyState
        icon="RiTaskLine"
        title={copy("mobile_overview_linear_empty")}
        hint={configured === null ? copy("mobile_overview_linear_connect_hint") : undefined}
      />
    )
  return (
    <GroupedCard>
      {issues.value.map((issue) => (
        <IssueRow key={issue.id} issue={issue} onPress={() => onPick(issue)} />
      ))}
    </GroupedCard>
  )
}

const stateGlyph = (theme: Palette, type: string): { name: IconName; color: string } => {
  if (type === "started") return { name: "RiProgress4Line", color: theme.attention }
  if (type === "unstarted") return { name: "Circle", color: theme.text }
  return { name: "Circle", color: theme.textMuted }
}

const priorityLabel = (priority: number) =>
  priority === 1 || priority === 2 || priority === 3 || priority === 4
    ? copy(`mobile_overview_priority_${priority}`)
    : null

function IssueRow({ issue, onPress }: { issue: LinearIssue; onPress: () => void }) {
  const theme = useTheme()
  const priority = priorityLabel(issue.priority)
  return (
    <Pressable
      testID="overview-issue"
      accessibilityRole="button"
      accessibilityLabel={[issue.identifier, issue.title, issue.state.name, priority].filter(Boolean).join(", ")}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <View style={styles.rowIcon}>
        <Icon {...stateGlyph(theme, issue.state.type)} size={18} />
      </View>
      <View style={styles.rowBody}>
        <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
          <Text style={[styles.identifier, { color: theme.textMuted }]}>{issue.identifier}</Text> {issue.title}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: theme.textMuted }]}>{issue.state.name}</Text>
          {priority !== null && (
            <Text style={[styles.metaText, { color: issue.priority === 1 ? theme.danger : theme.textMuted }]}>
              {priority}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  )
}

function IssueHeader({ issue }: { issue: LinearIssue }) {
  const theme = useTheme()
  return (
    <View style={styles.issueHeader}>
      <Text style={[styles.issueTitle, { color: theme.text }]}>{issue.title}</Text>
      <Button
        testID="open-in-linear"
        label={copy("mobile_overview_open_linear")}
        icon="External"
        style={styles.openLinear}
        onPress={() => openWebUrl(issue.url)}
      />
      <Text style={[styles.startLabel, { color: theme.textMuted }]}>{copy("mobile_overview_start_thread")}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 },
  column: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center", gap: 4 },
  row: { minHeight: HIT, flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  rowIcon: { paddingTop: 2 },
  rowBody: { flex: 1, gap: 4, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { flexShrink: 1, fontSize: 16, lineHeight: 22, fontWeight: "500" },
  identifier: { fontFamily: mono, fontSize: 13, fontWeight: "400" },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 },
  metaText: { fontSize: 13, lineHeight: 18 },
  reference: { flexShrink: 0, maxWidth: "60%", fontVariant: ["tabular-nums"] },
  thread: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
  threadTitle: { flexShrink: 1 },
  progress: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2 },
  progressLabel: { flexShrink: 1, fontSize: 14, fontWeight: "500" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 24 },
  failed: { gap: 8 },
  retry: { alignSelf: "flex-start" },
  issueHeader: { gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
  issueTitle: { fontSize: 16, lineHeight: 22 },
  openLinear: { alignSelf: "flex-start" },
  startLabel: { fontSize: 13, fontWeight: "500", paddingTop: 6 },
})
