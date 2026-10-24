import type { LinearIssue } from "@shared/domain.ts"
import { parseGitHubRepository } from "@shared/github.ts"
import { router, useFocusEffect } from "expo-router"
import { useCallback, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Reveal, Spinner } from "@/components/motion"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { SectionLabel } from "@/components/thread-row"
import { Button, EmptyState, Notice, Pill, type Tone } from "@/components/ui"
import { mono, type Palette, READABLE_WIDTH, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { openWebUrl } from "@/lib/open-url"
import { issueDraft, type OverviewPullRequest, type PullRequestNeed, pullRequestOverview } from "@/lib/overview"
import { checksIcon, checksLabel, reviewLabel, statusGlyph, statusLabel } from "@/lib/pull-request-labels"
import { useLinear } from "@/stores/linear"
import { pullRequestNumber, usePullRequests } from "@/stores/pull-requests"
import { useThreads } from "@/stores/threads"

/** Each read runs `gh` on the desktop, so the overview keeps only a few of them going at once. */
const PULL_REQUEST_READS = 4

async function readPullRequests(urls: readonly string[], force: boolean) {
  const queue = [...urls]
  const { loadPullRequest } = usePullRequests.getState()
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) await loadPullRequest(url, { force })
  }
  await Promise.all(Array.from({ length: PULL_REQUEST_READS }, worker))
}

/**
 * Reads the overview whenever the screen comes into view or the phone reconnects. `urls` is newline-joined, so the
 * reads run again only when the set of pull requests changes. Recent reads are skipped by the stores.
 */
function useReadOnFocus(connected: boolean, urls: string) {
  useFocusEffect(
    useCallback(() => {
      if (!connected) return
      void readPullRequests(urls === "" ? [] : urls.split("\n"), false)
      void useLinear.getState().load()
    }, [connected, urls]),
  )
}

/** Which pull requests need the developer, and which Linear tickets are theirs, read through the desktop. */
export default function OverviewScreen() {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const linksByThread = usePullRequests((state) => state.linksByThread)
  const pullRequests = usePullRequests((state) => state.pullRequests)
  const threads = useThreads((state) => state.byId)
  const [refreshing, setRefreshing] = useState(false)
  const [issue, setIssue] = useState<LinearIssue | null>(null)

  const overview = pullRequestOverview(Object.values(linksByThread).flat(), threads, pullRequests)
  useReadOnFocus(connected, overview.urls.join("\n"))

  const refresh = async () => {
    setRefreshing(true)
    try {
      await Promise.all([
        usePullRequests.getState().load(),
        readPullRequests(overview.urls, true),
        useLinear.getState().load({ force: true }),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  const groups = [
    { label: copy("mobile_overview_needs_you"), rows: overview.attention },
    { label: copy("mobile_overview_open"), rows: overview.open },
    { label: copy("mobile_overview_merged"), rows: overview.merged },
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
        <Heading label={copy("mobile_overview_pull_requests")} />
        {groups.length === 0 ? (
          <EmptyState
            icon="RiGitPullRequestLine"
            title={copy("mobile_overview_pull_requests_empty")}
            hint={copy("mobile_overview_pull_requests_empty_hint")}
          />
        ) : (
          groups.map((group) => (
            <View key={group.label}>
              <SectionLabel label={group.label} />
              {group.rows.map((row) => (
                <PullRequestRow key={row.url} row={row} />
              ))}
            </View>
          ))
        )}
        <Heading label={copy("mobile_overview_linear")} />
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

function Heading({ label }: { label: string }) {
  const theme = useTheme()
  return (
    <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>
      {label}
    </Text>
  )
}

const needs: Record<PullRequestNeed, { label: () => string; tone: Tone }> = {
  checks: { label: () => checksLabel("failing"), tone: "danger" },
  changes: { label: () => reviewLabel("changesRequested"), tone: "attention" },
  conflicts: { label: () => copy("mobile_pr_conflicting"), tone: "danger" },
}

function PullRequestRow({ row }: { row: OverviewPullRequest }) {
  const theme = useTheme()
  const thread = useThreads((state) => state.byId[row.threadId])
  const { pullRequest } = row
  const repository = parseGitHubRepository(row.url)
  const number = pullRequest?.number ?? pullRequestNumber(row.url) ?? "?"
  const reference = `${repository === null ? "" : `${repository.owner}/${repository.name} `}#${number}`
  const glyph =
    pullRequest === null
      ? { name: "RiGitPullRequestLine" as const, color: theme.textMuted }
      : statusGlyph(theme)[pullRequest.status]
  const checks = pullRequest !== null && pullRequest.status !== "merged" ? pullRequest.checks : null

  const label = [
    pullRequest?.title,
    reference,
    pullRequest !== null && statusLabel(pullRequest.status),
    checks !== null && checksLabel(checks),
    ...row.needs.filter((need) => need !== "checks").map((need) => needs[need].label()),
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
          {checks !== null && (
            <Icon name={checksIcon[checks]} size={14} color={checks === "failing" ? theme.danger : theme.textMuted} />
          )}
          {thread !== undefined && (
            <View style={styles.thread}>
              <Icon name="RiChat1Line" size={13} color={theme.textMuted} />
              <Text numberOfLines={1} style={[styles.metaText, styles.threadTitle, { color: theme.textMuted }]}>
                {thread.title}
              </Text>
            </View>
          )}
        </View>
        {row.needs.length > 0 && (
          <View style={styles.pills}>
            {row.needs.map((need) => (
              <Pill key={need} label={needs[need].label()} tone={needs[need].tone} />
            ))}
          </View>
        )}
        {row.error !== null && (
          <Text numberOfLines={2} style={[styles.metaText, { color: theme.danger }]}>
            {copy("mobile_pr_card_failed", { message: row.error })}
          </Text>
        )}
      </View>
    </Pressable>
  )
}

function LinearIssues({ connected, onPick }: { connected: boolean; onPick: (issue: LinearIssue) => void }) {
  const theme = useTheme()
  const issues = useLinear((state) => state.issues)
  const configured = useLinear((state) => state.configured)

  if (issues === undefined || issues.status === "loading") {
    if (!connected) return null
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
            icon="RiRefreshLine"
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
  return issues.value.map((issue) => <IssueRow key={issue.id} issue={issue} onPress={() => onPick(issue)} />)
}

const stateGlyph = (theme: Palette, type: string): { name: IconName; color: string } => {
  if (type === "started") return { name: "RiProgress4Line", color: theme.attention }
  if (type === "unstarted") return { name: "RiCircleLine", color: theme.text }
  return { name: "RiCircleLine", color: theme.textMuted }
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
        icon="RiExternalLinkLine"
        style={styles.openLinear}
        onPress={() => openWebUrl(issue.url)}
      />
      <Text style={[styles.startLabel, { color: theme.textMuted }]}>{copy("mobile_overview_start_thread")}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 8, paddingTop: 8, paddingBottom: 32 },
  column: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center", gap: 4 },
  heading: { fontSize: 20, fontWeight: "700", paddingHorizontal: 10, paddingTop: 16, paddingBottom: 2 },
  row: { flexDirection: "row", gap: 10, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 10 },
  rowIcon: { paddingTop: 2 },
  rowBody: { flex: 1, gap: 4, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { flexShrink: 1, fontSize: 16, lineHeight: 22, fontWeight: "500" },
  identifier: { fontFamily: mono, fontSize: 13, fontWeight: "400" },
  meta: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 18 },
  metaText: { fontSize: 13, lineHeight: 18 },
  reference: { flexShrink: 0, maxWidth: "60%", fontVariant: ["tabular-nums"] },
  thread: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
  threadTitle: { flexShrink: 1 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 24 },
  failed: { gap: 8, paddingHorizontal: 8 },
  retry: { alignSelf: "flex-start" },
  issueHeader: { gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  issueTitle: { fontSize: 16, lineHeight: 22 },
  openLinear: { alignSelf: "flex-start" },
  startLabel: { fontSize: 13, fontWeight: "500", paddingTop: 6 },
})
