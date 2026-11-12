import { useAtomMount } from "@effect/atom-react"
import type {
  CheckRun,
  CheckRunStatus,
  MergeMethod,
  PullRequestDetail,
  PullRequestLink,
  PullRequestStatus,
} from "@shared/domain.ts"
import { codeHostName, codeHostOfUrl, pullRequestNumberLabel, pullRequestNumberLabelOfUrl } from "@shared/codeHost.ts"
import { linearReviewUrl } from "@shared/github.ts"
import { providerInfo } from "@shared/providers.ts"
import { fixChecksPrompt, resolveConflictsPrompt } from "@shared/pullRequestPrompts.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { type ReactNode, useState } from "react"
import { Alert, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { Markdown } from "@/components/markdown"
import { FadeIn, PressableScale, Reveal, Rotate, Spinner } from "@/components/motion"
import { LineCounts, PullRequestCode } from "@/components/pull-request-code"
import { GroupedCard } from "@/components/grouped-card"
import { OptionRow, Sheet } from "@/components/sheet"
import { Button, IconButton, Notice, Pill, Toggle, UnderlineTabs } from "@/components/ui"
import { HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { mergeChoice } from "@/lib/merge-methods"
import { openWebUrl } from "@/lib/open-url"
import { reviewLabel, reviewTone, statusGlyph, statusLabel } from "@/lib/pull-request-labels"
import { filesKey, loadDetailAtom, usePullRequests } from "@/stores/pull-requests"
import { useThreads } from "@/stores/threads"

type Tab = "info" | "code"

const tabs = [
  { value: "info", label: copy("mobile_pr_tab_info") },
  { value: "code", label: copy("mobile_pr_tab_code") },
] as const

type WebLink = { readonly href: string; readonly label: string }

const hostNameOf = (url: string) => codeHostName(codeHostOfUrl(url))

function useWebLink(threadId: string, url: string): WebLink {
  const linearReview = useThreads((state) => {
    const projectId = state.byId[threadId]?.projectId
    return state.projects.find((project) => project.id === projectId)?.linearReview ?? false
  })
  return linearReview
    ? { href: linearReviewUrl(url), label: copy("mobile_pr_open_linear_review") }
    : { href: url, label: copy("mobile_pr_open_on_host", { host: hostNameOf(url) }) }
}

const reloadWithCode = async (reload: () => Promise<unknown>, url: string, withCode: boolean) => {
  await reload()
  const { details, files, guides, loadFiles, loadGuide } = usePullRequests.getState()
  const detail = details[url]
  if (withCode && detail?.status === "ready") {
    const { head } = detail.value
    await Promise.all([
      files[filesKey(url, head)] === undefined ? null : loadFiles(url, head, { force: true }),
      guides[url] === undefined ? null : loadGuide(url, { force: true }),
    ])
  }
}

export default function PullRequestScreen() {
  const theme = useTheme()
  const { id, url } = useLocalSearchParams<{ id: string; url: string }>()
  const remote = usePullRequests((state) => state.details[url])
  const link = usePullRequests((state) => state.linksByThread[id]?.find((existing) => existing.url === url) ?? null)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<Tab>("info")
  const [barHeight, setBarHeight] = useState(0)
  const web = useWebLink(id, url)

  useAtomMount(loadDetailAtom(url))

  const reload = () => usePullRequests.getState().loadDetail(url, { force: true })
  const refresh = async () => {
    setRefreshing(true)
    await reloadWithCode(reload, url, tab === "code").finally(() => setRefreshing(false))
  }

  const numberLabel = pullRequestNumberLabelOfUrl(url)

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: numberLabel }} />
      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: 16 + barHeight }]}
        scrollIndicatorInsets={{ bottom: barHeight }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.textMuted} />
        }
      >
        <View style={styles.column}>
          {remote === undefined || remote.status === "loading" ? (
            <Reveal style={styles.loading}>
              <Spinner color={theme.textMuted} />
              <Text style={{ color: theme.textMuted }}>{copy("mobile_pr_detail_loading")}</Text>
            </Reveal>
          ) : remote.status === "error" ? (
            <View style={styles.section}>
              <Notice tone="danger" text={copy("mobile_pr_detail_failed", { message: remote.message })} />
              <Button label={copy("mobile_pr_retry")} icon="Refresh" onPress={() => void reload()} style={styles.start} />
            </View>
          ) : (
            <PullRequestView
              detail={remote.value}
              threadId={id}
              link={link}
              tab={tab}
              onTabChange={setTab}
              onChanged={reload}
            />
          )}
        </View>
      </ScrollView>
      <View
        pointerEvents="box-none"
        style={styles.floating}
        onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}
      >
        <ActionBar web={web} detail={remote?.status === "ready" ? remote.value : null} onChanged={reload} />
      </View>
    </View>
  )
}

const isOpen = (detail: PullRequestDetail) => detail.status === "open" || detail.status === "draft"

function StatePill({ status }: { status: PullRequestStatus }) {
  const theme = useTheme()
  const glyph = statusGlyph(theme)[status]
  return (
    <View style={[styles.state, { backgroundColor: glyph.color }]}>
      <Icon name={glyph.name} size={14} color={theme.card} />
      <Text style={[styles.stateLabel, { color: theme.card }]}>{statusLabel(status)}</Text>
    </View>
  )
}

function PullRequestView({
  detail,
  threadId,
  link,
  tab,
  onTabChange,
  onChanged,
}: {
  detail: PullRequestDetail
  threadId: string
  link: PullRequestLink | null
  tab: Tab
  onTabChange: (tab: Tab) => void
  onChanged: () => Promise<void>
}) {
  const theme = useTheme()
  const watching = (link?.watch ?? null) !== null
  return (
    <>
      <View style={styles.header}>
        <View style={styles.headline}>
          <StatePill status={detail.status} />
          <Text style={[styles.number, { color: theme.textMuted }]}>{numberLabelOf(detail)}</Text>
          <LineCounts added={detail.additions} removed={detail.deletions} />
          {isOpen(detail) && detail.review !== null && (
            <Pill label={reviewLabel(detail.review)} tone={reviewTone[detail.review]} />
          )}
        </View>
        <Text accessibilityRole="header" selectable style={[styles.title, { color: theme.text }]}>
          {detail.title}
        </Text>
        <Text numberOfLines={1} style={[styles.branches, { color: theme.textMuted }]}>
          {detail.headRef} → {detail.baseRef}
        </Text>
        <Text style={[styles.author, { color: theme.textMuted }]}>
          {copy("mobile_pr_author", { author: detail.author })}
        </Text>
      </View>
      <UnderlineTabs<Tab>
        tabs={tabs}
        value={tab}
        onChange={onTabChange}
        accessibilityLabel={copy("mobile_pr_view_label")}
        style={[styles.tabs, { borderBottomColor: theme.border }]}
      />
      {tab === "code" ? (
        <PullRequestCode detail={detail} />
      ) : (
        <Info detail={detail} threadId={threadId} watching={watching} onChanged={onChanged} />
      )}
    </>
  )
}

function Info({
  detail,
  threadId,
  watching,
  onChanged,
}: {
  detail: PullRequestDetail
  threadId: string
  watching: boolean
  onChanged: () => Promise<void>
}) {
  const theme = useTheme()
  const conflicting = isOpen(detail) && detail.mergeable === "conflicting"
  const failing = detail.checkRuns.filter((run) => run.status === "failing").length
  const [watchError, setWatchError] = useState<string | null>(null)
  return (
    <>
      <GroupedCard inset={16}>
        <Checks detail={detail} />
        {isOpen(detail) && <MergeState detail={detail} />}
        {isOpen(detail) && (
          <WatchRow url={detail.url} threadId={threadId} watching={watching} onError={setWatchError} />
        )}
      </GroupedCard>
      {watchError !== null && <Notice tone="danger" text={watchError} />}
      {conflicting && (
        <AskAgentButton threadId={threadId} prompt={resolveConflictsPrompt(detail)} label={copy("mobile_pr_resolve")} />
      )}
      {failing > 0 && isOpen(detail) && (
        <View style={styles.section}>
          <Notice tone="danger" text={copy("mobile_pr_failing_count", { count: String(failing) })} />
          <AskAgentButton threadId={threadId} prompt={fixChecksPrompt(detail)} label={copy("mobile_pr_fix")} />
        </View>
      )}
      <Block title={copy("mobile_pr_description")}>
        {detail.body.trim() === "" ? (
          <Text style={{ color: theme.textMuted, fontSize: 14 }}>{copy("mobile_pr_no_description")}</Text>
        ) : (
          <Markdown text={detail.body} root={null} />
        )}
      </Block>
      {isOpen(detail) && <CloseButton detail={detail} onChanged={onChanged} />}
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.blockTitle, { color: theme.textMuted }]}>
        {title}
      </Text>
      {children}
    </View>
  )
}

function StatusRow({
  icon,
  title,
  detail,
  trailing,
}: {
  icon: ReactNode
  title: string
  detail: string
  trailing?: ReactNode
}) {
  const theme = useTheme()
  return (
    <View style={styles.statusRow}>
      <View style={[styles.statusIcon, { backgroundColor: theme.surface }]}>{icon}</View>
      <View style={styles.statusText}>
        <Text style={[styles.statusTitle, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.statusDetail, { color: theme.textMuted }]}>{detail}</Text>
      </View>
      {trailing}
    </View>
  )
}

function AskAgentButton({ threadId, prompt, label }: { threadId: string; prompt: string; label: string }) {
  const theme = useTheme()
  const steers = useThreads((state) => {
    const provider = state.byId[threadId]?.provider
    return provider === undefined || providerInfo[provider].steersRunningTurn
  })
  const [state, setState] = useState<
    { type: "idle" } | { type: "sending" } | { type: "sent" } | { type: "failed"; message: string }
  >({ type: "idle" })

  const send = async () => {
    setState({ type: "sending" })
    const method = steers ? "threads.steer" : "threads.queue"
    try {
      await call(method, { threadId, text: prompt })
      setState({ type: "sent" })
    } catch (cause) {
      setState({ type: "failed", message: errorText(cause) })
    }
  }

  return (
    <View style={styles.ask}>
      <Button
        label={label}
        icon="Chat"
        busy={state.type === "sending"}
        onPress={() => void send()}
        style={styles.roundedButton}
      />
      {state.type === "sent" && (
        <View accessibilityRole="alert" style={styles.sent}>
          <Icon name="Check" size={16} color={theme.running} />
          <Text style={{ color: theme.textMuted, fontSize: 14 }}>{copy("mobile_pr_sent")}</Text>
        </View>
      )}
      {state.type === "failed" && <Notice tone="danger" text={state.message} />}
    </View>
  )
}

const runOrder: Record<CheckRunStatus, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 }

const countOf = (runs: readonly CheckRun[], status: CheckRunStatus) =>
  runs.filter((run) => run.status === status).length

function Checks({ detail }: { detail: PullRequestDetail }) {
  const theme = useTheme()
  const runs = [...detail.checkRuns].sort((a, b) => runOrder[a.status] - runOrder[b.status])
  const failing = countOf(runs, "failing")
  const pending = countOf(runs, "pending")
  const [expanded, setExpanded] = useState(failing > 0 || pending > 0)
  const summary =
    runs.length === 0
      ? copy("mobile_pr_no_checks")
      : [
          failing > 0 && copy("mobile_pr_checks_failed_count", { count: String(failing) }),
          pending > 0 && copy("mobile_pr_checks_running_count", { count: String(pending) }),
          countOf(runs, "passing") > 0 &&
            copy("mobile_pr_checks_passed", { count: String(countOf(runs, "passing")) }),
          countOf(runs, "skipped") > 0 &&
            copy("mobile_pr_checks_skipped", { count: String(countOf(runs, "skipped")) }),
        ]
          .filter((part) => typeof part === "string")
          .join(", ")
  const icon =
    pending > 0 ? (
      <Spinner size={18} color={theme.textMuted} />
    ) : failing > 0 ? (
      <Icon name="XCircle" size={18} color={theme.danger} />
    ) : runs.length === 0 ? (
      <Icon name="MinusCircle" size={18} color={theme.textMuted} />
    ) : (
      <Icon name="Check" size={18} color={theme.running} />
    )
  const row = (
    <StatusRow
      icon={icon}
      title={copy("mobile_pr_checks")}
      detail={summary}
      trailing={
        runs.length > 0 && (
          <Rotate turned={expanded}>
            <Icon name="ChevronRight" size={18} color={theme.textMuted} />
          </Rotate>
        )
      }
    />
  )
  if (runs.length === 0) return row
  return (
    <View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${copy("mobile_pr_checks")}, ${summary}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        {row}
      </PressableScale>
      {expanded && (
        <FadeIn style={styles.runs}>
          {runs.map((run, index) => (
            <CheckRow key={`${index}:${run.name}`} run={run} host={hostNameOf(detail.url)} />
          ))}
        </FadeIn>
      )}
    </View>
  )
}

const runLabel = (status: CheckRunStatus) => copy(`mobile_pr_check_${status}`)

function CheckRow({ run, host }: { run: CheckRun; host: string }) {
  const theme = useTheme()
  const glyphs: Record<Exclude<CheckRunStatus, "pending">, { name: IconName; color: string }> = {
    passing: { name: "CheckCircleFill", color: theme.textMuted },
    failing: { name: "XCircle", color: theme.danger },
    skipped: { name: "MinusCircle", color: theme.textMuted },
  }
  const content = (
    <>
      {run.status === "pending" ? (
        <Spinner size={16} color={theme.textMuted} />
      ) : (
        <Icon {...glyphs[run.status]} size={16} />
      )}
      <Text
        numberOfLines={2}
        style={[styles.runName, { color: run.status === "failing" ? theme.text : theme.textMuted }]}
      >
        {run.name}
      </Text>
    </>
  )
  const label = `${run.name}, ${runLabel(run.status)}`
  if (run.url === null) {
    return (
      <View accessible accessibilityLabel={label} style={styles.run}>
        {content}
      </View>
    )
  }
  const url = run.url
  return (
    <PressableScale
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={copy("mobile_pr_check_open", { host })}
      onPress={() => openWebUrl(url)}
      style={styles.run}
    >
      {content}
    </PressableScale>
  )
}

function MergeState({ detail }: { detail: PullRequestDetail }) {
  const theme = useTheme()
  if (detail.status === "draft") {
    return (
      <StatusRow
        icon={<Icon name="RiGitPrDraftLine" size={18} color={theme.textMuted} />}
        title={copy("mobile_pr_state_draft")}
        detail={copy("mobile_pr_merge_blocked_draft", { host: hostNameOf(detail.url) })}
      />
    )
  }
  if (detail.mergeable === "conflicting") {
    return (
      <StatusRow
        icon={<Icon name="Warning" size={18} color={theme.attention} />}
        title={copy("mobile_pr_conflicting")}
        detail={copy("mobile_pr_conflicts", { base: detail.baseRef })}
      />
    )
  }
  if (detail.mergeable !== "mergeable") return null
  return (
    <StatusRow
      icon={<Icon name="RiGitMergeLine" size={18} color={theme.running} />}
      title={copy("mobile_pr_mergeable")}
      detail={copy("mobile_pr_no_conflicts", { base: detail.baseRef })}
    />
  )
}

function WatchRow({
  url,
  threadId,
  watching,
  onError,
}: {
  url: string
  threadId: string
  watching: boolean
  onError: (message: string | null) => void
}) {
  const theme = useTheme()
  const [pending, setPending] = useState<boolean | null>(null)

  const change = async (watch: boolean) => {
    setPending(watch)
    onError(null)
    const method = watch ? "pullRequests.watch" : "pullRequests.unwatch"
    try {
      await call(method, { threadId, url })
    } catch (cause) {
      onError(errorText(cause))
    }
    setPending(null)
  }

  return (
    <StatusRow
      icon={<Icon name="Bell" size={18} color={theme.prMerged} />}
      title={copy("mobile_pr_watch")}
      detail={copy("mobile_pr_watch_hint")}
      trailing={
        <Toggle
          accessibilityLabel={copy("mobile_pr_watch")}
          accessibilityHint={copy("mobile_pr_watch_hint")}
          value={pending ?? watching}
          disabled={pending !== null}
          onValueChange={(watch) => void change(watch)}
        />
      }
    />
  )
}

// FIXME: Alert.alert has no buttons on react-native-web.
function confirm(title: string, message: string, action: string, destructive: boolean, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm()
    return
  }
  Alert.alert(title, message, [
    { text: copy("mobile_pr_cancel"), style: "cancel" },
    { text: action, style: destructive ? "destructive" : "default", onPress: onConfirm },
  ])
}

const numberLabelOf = (pullRequest: PullRequestDetail) =>
  pullRequestNumberLabel(codeHostOfUrl(pullRequest.url), pullRequest.number)

const mergeLabel = (method: MergeMethod) => copy(`mobile_pr_merge_${method === "merge" ? "commit" : method}`)

function useGitHubAction(url: string, onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await Promise.all([onChanged(), usePullRequests.getState().loadPullRequest(url, { force: true })])
    } catch (cause) {
      setError(errorText(cause))
    }
    setBusy(false)
  }
  return { busy, error, run }
}

function ActionBar({
  web,
  detail,
  onChanged,
}: {
  web: WebLink
  detail: PullRequestDetail | null
  onChanged: () => Promise<void>
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [picking, setPicking] = useState(false)
  const [chosenMethod, setMethod] = useState<MergeMethod>("squash")
  const { methods, method } = mergeChoice(detail?.url ?? "", chosenMethod)
  const { busy, error, run } = useGitHubAction(detail?.url ?? "", onChanged)
  const canMerge = detail !== null && detail.status === "open" && detail.mergeable !== "conflicting"

  const merge = (picked: MergeMethod) => {
    if (detail === null) return
    confirm(
      copy("mobile_pr_merge_title", { method: mergeLabel(picked), number: numberLabelOf(detail) }),
      copy("mobile_pr_merge_body", { head: detail.headRef, base: detail.baseRef, host: hostNameOf(detail.url) }),
      mergeLabel(picked),
      false,
      () => void run(() => call("github.merge", { url: detail.url, method: picked })),
    )
  }

  const pickMethod = (picked: MergeMethod) => {
    setMethod(picked)
    setPicking(false)
  }

  return (
    <View pointerEvents="box-none" style={[styles.bar, { paddingBottom: 8 + insets.bottom }]}>
      {error !== null && <Notice tone="danger" text={error} />}
      <View pointerEvents="box-none" style={styles.barRow}>
        <IconButton
          icon="External"
          accessibilityLabel={web.label}
          onPress={() => openWebUrl(web.href)}
          style={[styles.round, { backgroundColor: theme.card, borderColor: theme.border }]}
        />
        {canMerge && (
          <>
            <Button
              testID="pull-request-merge"
              label={mergeLabel(method)}
              icon="RiGitMergeLine"
              variant="primary"
              busy={busy}
              onPress={() => merge(method)}
              style={styles.merge}
            />
            <IconButton
              testID="pull-request-merge-method"
              icon="ChevronUp"
              accessibilityLabel={copy("mobile_pr_merge_method")}
              accessibilityValue={{ text: mergeLabel(method) }}
              disabled={busy}
              onPress={() => setPicking(true)}
              style={[styles.round, { backgroundColor: theme.card, borderColor: theme.border }]}
            />
          </>
        )}
      </View>
      <Sheet title={copy("mobile_pr_merge_method")} open={picking} onClose={() => setPicking(false)} fit>
        <View accessibilityRole="radiogroup" accessibilityLabel={copy("mobile_pr_merge_method")}>
          <GroupedCard inset={16}>
            {methods.map((option) => (
              <OptionRow
                key={option}
                label={mergeLabel(option)}
                icon="RiGitMergeLine"
                selected={option === method}
                onPress={() => pickMethod(option)}
              />
            ))}
          </GroupedCard>
        </View>
      </Sheet>
    </View>
  )
}

function CloseButton({ detail, onChanged }: { detail: PullRequestDetail; onChanged: () => Promise<void> }) {
  const { busy, error, run } = useGitHubAction(detail.url, onChanged)
  const close = () =>
    confirm(
      copy("mobile_pr_close_title", { number: numberLabelOf(detail) }),
      copy("mobile_pr_close_body", { host: hostNameOf(detail.url) }),
      copy("mobile_pr_close_confirm"),
      true,
      () => void run(() => call("github.close", { url: detail.url })),
    )
  return (
    <View style={styles.section}>
      {error !== null && <Notice tone="danger" text={error} />}
      <Button
        label={copy("mobile_pr_close")}
        icon="RiGitClosePullRequestLine"
        variant="dangerGhost"
        busy={busy}
        onPress={close}
        style={styles.close}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  page: { padding: 16, flexGrow: 1 },
  column: { width: "100%", maxWidth: 760, alignSelf: "center", gap: 20 },
  tabs: { borderBottomWidth: StyleSheet.hairlineWidth, marginTop: -8 },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 32 },
  header: { gap: 8 },
  headline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  state: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.full,
  },
  stateLabel: { fontSize: 15, fontWeight: "600" },
  number: { fontFamily: mono, fontSize: 14 },
  title: { fontSize: 24, fontWeight: "700", lineHeight: 30 },
  branches: { fontFamily: mono, fontSize: 13 },
  author: { fontSize: 13 },
  section: { gap: 8 },
  start: { alignSelf: "flex-start" },
  blockTitle: { fontSize: 15, fontWeight: "600" },
  ask: { gap: 8, alignItems: "flex-start" },
  roundedButton: { borderRadius: radius.full },
  sent: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusRow: { minHeight: HIT + 20, flexDirection: "row", alignItems: "center", gap: 14, padding: 14 },
  statusIcon: { width: 36, height: 36, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  statusText: { flex: 1, gap: 2 },
  statusTitle: { fontSize: 16, fontWeight: "500" },
  statusDetail: { fontSize: 14, lineHeight: 19 },
  runs: { paddingHorizontal: 14, paddingBottom: 6 },
  run: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 10 },
  runName: { flex: 1, fontSize: 14, lineHeight: 19, paddingVertical: 6 },
  floating: { position: "absolute", left: 0, right: 0, bottom: 0 },
  bar: { gap: 8, paddingHorizontal: 16, paddingTop: 8, width: "100%", maxWidth: 792, alignSelf: "center" },
  barRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  round: { width: HIT + 8, height: HIT + 8, borderRadius: radius.full, boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)" },
  merge: { flex: 1, minHeight: HIT + 8, borderRadius: radius.full },
  close: { alignSelf: "flex-start", marginLeft: -12 },
})
