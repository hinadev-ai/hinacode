import type { CheckRun, CheckRunStatus, MergeMethod, PullRequestDetail, PullRequestLink } from "@shared/domain.ts"
import { linearReviewUrl } from "@shared/github.ts"
import { fixChecksPrompt, resolveConflictsPrompt } from "@shared/pullRequestPrompts.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { type ReactNode, useEffect, useState } from "react"
import { Alert, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Markdown } from "@/components/markdown"
import { FadeIn, PressableScale, Reveal, Rotate, Spinner } from "@/components/motion"
import { PullRequestCode } from "@/components/pull-request-code"
import { PullRequestState } from "@/components/pull-request-state"
import { reviewLabel, reviewTone } from "@/lib/pull-request-labels"
import { OptionRow, Sheet } from "@/components/sheet"
import { Button, IconButton, Notice, Pill, Toggle, UnderlineTabs } from "@/components/ui"
import { HIT, mono } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { openWebUrl } from "@/lib/open-url"
import { errorText } from "@/lib/error-text"
import { filesKey, pullRequestNumber, usePullRequests } from "@/stores/pull-requests"
import { useThreads } from "@/stores/threads"

type Tab = "info" | "code"

const tabs = [
  { value: "info", label: copy("mobile_pr_tab_info") },
  { value: "code", label: copy("mobile_pr_tab_code") },
] as const

/** Where the thread's pull request links open: GitHub, or linear.review when its project turned that on. */
function useWebLink(threadId: string, url: string) {
  const linearReview = useThreads((state) => {
    const projectId = state.byId[threadId]?.projectId
    return state.projects.find((project) => project.id === projectId)?.linearReview ?? false
  })
  return linearReview
    ? { href: linearReviewUrl(url), label: copy("mobile_pr_open_linear_review") }
    : { href: url, label: copy("mobile_pr_open_github") }
}

export default function PullRequestScreen() {
  const theme = useTheme()
  const { id, url } = useLocalSearchParams<{ id: string; url: string }>()
  const connected = useConnection((state) => state.status === "connected")
  const remote = usePullRequests((state) => state.details[url])
  const link = usePullRequests((state) => state.linksByThread[id]?.find((existing) => existing.url === url) ?? null)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<Tab>("info")
  const web = useWebLink(id, url)

  useEffect(() => {
    if (connected) void usePullRequests.getState().loadDetail(url)
  }, [connected, url])

  const reload = () => usePullRequests.getState().loadDetail(url, { force: true })
  const refresh = async () => {
    setRefreshing(true)
    try {
      await reload()
      const { details, files, guides, loadFiles, loadGuide } = usePullRequests.getState()
      const detail = details[url]
      if (tab === "code" && detail?.status === "ready") {
        const { head } = detail.value
        await Promise.all([
          files[filesKey(url, head)] === undefined ? null : loadFiles(url, head, { force: true }),
          guides[url] === undefined ? null : loadGuide(url, { force: true }),
        ])
      }
    } finally {
      setRefreshing(false)
    }
  }

  const number = remote?.status === "ready" ? String(remote.value.number) : pullRequestNumber(url)

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.page}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.textMuted} />
      }
    >
      <Stack.Screen
        options={{
          title: number === null ? "" : `#${number}`,
          headerRight: () => (
            <IconButton icon="RiExternalLinkLine" accessibilityLabel={web.label} onPress={() => openWebUrl(web.href)} />
          ),
        }}
      />
      <View style={styles.column}>
        {remote === undefined || remote.status === "loading" ? (
          <Reveal style={styles.loading}>
            <Spinner color={theme.textMuted} />
            <Text style={{ color: theme.textMuted }}>{copy("mobile_pr_detail_loading")}</Text>
          </Reveal>
        ) : remote.status === "error" ? (
          <View style={styles.section}>
            <Notice tone="danger" text={copy("mobile_pr_detail_failed", { message: remote.message })} />
            <View style={styles.actions}>
              <Button label={copy("mobile_pr_retry")} icon="RiRefreshLine" onPress={() => void reload()} />
              <Button label={web.label} icon="RiExternalLinkLine" onPress={() => openWebUrl(web.href)} />
            </View>
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
  )
}

const isOpen = (detail: PullRequestDetail) => detail.status === "open" || detail.status === "draft"

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
  const conflicting = isOpen(detail) && detail.mergeable === "conflicting"
  const watching = (link?.watch ?? null) !== null
  return (
    <>
      <View style={styles.header}>
        <Text accessibilityRole="header" selectable style={[styles.title, { color: theme.text }]}>
          {detail.title}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: theme.textMuted }]}>
            {copy("mobile_pr_author", { author: detail.author })}
          </Text>
          <Text numberOfLines={1} style={[styles.branches, { color: theme.textMuted }]}>
            {detail.headRef} → {detail.baseRef}
          </Text>
          <Text
            accessibilityLabel={copy("mobile_pr_size", {
              additions: String(detail.additions),
              deletions: String(detail.deletions),
            })}
            style={styles.branches}
          >
            <Text style={{ color: theme.running }}>+{detail.additions}</Text>{" "}
            <Text style={{ color: theme.danger }}>−{detail.deletions}</Text>
          </Text>
        </View>
        <View style={styles.pills}>
          <PullRequestState status={detail.status} />
          {isOpen(detail) && detail.review !== null && (
            <Pill label={reviewLabel(detail.review)} tone={reviewTone[detail.review]} />
          )}
          {isOpen(detail) && detail.mergeable === "mergeable" && (
            <Pill label={copy("mobile_pr_mergeable")} tone="neutral" icon="RiCheckLine" />
          )}
          {conflicting && <Pill label={copy("mobile_pr_conflicting")} tone="attention" icon="RiErrorWarningLine" />}
          {watching && <Pill label={copy("mobile_pr_watching")} tone="neutral" icon="RiEyeLine" />}
        </View>
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
  return (
    <>
      {conflicting && (
        <View style={styles.section}>
          <Notice tone="attention" text={copy("mobile_pr_conflicts", { base: detail.baseRef })} />
          <AskAgentButton
            threadId={threadId}
            prompt={resolveConflictsPrompt(detail)}
            label={copy("mobile_pr_resolve")}
          />
        </View>
      )}
      <Merge detail={detail} onChanged={onChanged} />
      {isOpen(detail) && <WatchRow url={detail.url} threadId={threadId} watching={watching} />}
      <Checks detail={detail} threadId={threadId} />
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

/** Sends the prompt into the thread: steers the running turn, or starts one. */
function AskAgentButton({ threadId, prompt, label }: { threadId: string; prompt: string; label: string }) {
  const theme = useTheme()
  const [state, setState] = useState<
    { type: "idle" } | { type: "sending" } | { type: "sent" } | { type: "failed"; message: string }
  >({ type: "idle" })

  const send = async () => {
    setState({ type: "sending" })
    try {
      await call("threads.steer", { threadId, text: prompt })
      setState({ type: "sent" })
    } catch (cause) {
      setState({ type: "failed", message: errorText(cause) })
    }
  }

  return (
    <View style={styles.ask}>
      <Button label={label} icon="RiChat1Line" busy={state.type === "sending"} onPress={() => void send()} />
      {state.type === "sent" && (
        <View accessibilityRole="alert" style={styles.sent}>
          <Icon name="RiCheckLine" size={16} color={theme.running} />
          <Text style={{ color: theme.textMuted, fontSize: 14 }}>{copy("mobile_pr_sent")}</Text>
        </View>
      )}
      {state.type === "failed" && <Notice tone="danger" text={state.message} />}
    </View>
  )
}

const runOrder: Record<CheckRunStatus, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 }

const needsAttention = (run: CheckRun) => run.status === "failing" || run.status === "pending"

/** Failing and running checks are always listed; the ones that passed or were skipped fold into one row. */
function Checks({ detail, threadId }: { detail: PullRequestDetail; threadId: string }) {
  const theme = useTheme()
  const runs = [...detail.checkRuns].sort((a, b) => runOrder[a.status] - runOrder[b.status])
  const failing = runs.filter((run) => run.status === "failing").length
  return (
    <Block title={copy("mobile_pr_checks")}>
      {runs.length === 0 ? (
        <Text style={{ color: theme.textMuted, fontSize: 14 }}>{copy("mobile_pr_no_checks")}</Text>
      ) : (
        <View>
          {runs.filter(needsAttention).map((run, index) => (
            <CheckRow key={`${index}:${run.name}`} run={run} />
          ))}
          <SettledChecks runs={runs.filter((run) => !needsAttention(run))} />
        </View>
      )}
      {failing > 0 && isOpen(detail) && (
        <View style={styles.section}>
          <Notice tone="danger" text={copy("mobile_pr_failing_count", { count: String(failing) })} />
          <AskAgentButton threadId={threadId} prompt={fixChecksPrompt(detail)} label={copy("mobile_pr_fix")} />
        </View>
      )}
    </Block>
  )
}

function SettledChecks({ runs }: { runs: readonly CheckRun[] }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  if (runs.length === 0) return null
  const passed = runs.filter((run) => run.status === "passing").length
  const skipped = runs.length - passed
  const summary = [
    passed > 0 && copy("mobile_pr_checks_passed", { count: String(passed) }),
    skipped > 0 && copy("mobile_pr_checks_skipped", { count: String(skipped) }),
  ]
    .filter((part) => typeof part === "string")
    .join(", ")
  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.run}
      >
        <Icon
          name={passed > 0 ? "RiCheckboxCircleFill" : "RiIndeterminateCircleLine"}
          size={16}
          color={theme.textMuted}
        />
        <Text style={[styles.runName, { color: theme.textMuted }]}>{summary}</Text>
        <Rotate turned={expanded}>
          <Icon name="RiArrowRightSLine" size={18} color={theme.textMuted} />
        </Rotate>
      </PressableScale>
      {expanded && (
        <FadeIn>
          {runs.map((run, index) => (
            <CheckRow key={`${index}:${run.name}`} run={run} />
          ))}
        </FadeIn>
      )}
    </>
  )
}

const runLabel = (status: CheckRunStatus) => copy(`mobile_pr_check_${status}`)

function CheckRow({ run }: { run: CheckRun }) {
  const theme = useTheme()
  const glyphs: Record<Exclude<CheckRunStatus, "pending">, { name: IconName; color: string }> = {
    passing: { name: "RiCheckboxCircleFill", color: theme.textMuted },
    failing: { name: "RiCloseCircleLine", color: theme.danger },
    skipped: { name: "RiIndeterminateCircleLine", color: theme.textMuted },
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
      accessibilityHint={copy("mobile_pr_check_open")}
      onPress={() => openWebUrl(url)}
      style={styles.run}
    >
      {content}
    </PressableScale>
  )
}

/** Alert.alert has no buttons on react-native-web. */
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

const mergeLabel = (method: MergeMethod) => copy(`mobile_pr_merge_${method === "merge" ? "commit" : method}`)
const mergeMethods: readonly MergeMethod[] = ["squash", "merge", "rebase"]

/** Runs a change to the pull request on GitHub, then reads it again, keeping the error when GitHub refuses. */
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

function Merge({ detail, onChanged }: { detail: PullRequestDetail; onChanged: () => Promise<void> }) {
  const theme = useTheme()
  const [picking, setPicking] = useState(false)
  const [method, setMethod] = useState<MergeMethod>("squash")
  const { busy, error, run } = useGitHubAction(detail.url, onChanged)
  const canMerge = detail.status === "open" && detail.mergeable !== "conflicting"

  const pickMethod = (picked: MergeMethod) => {
    setMethod(picked)
    confirm(
      copy("mobile_pr_merge_title", { method: mergeLabel(picked), number: String(detail.number) }),
      copy("mobile_pr_merge_body", { head: detail.headRef, base: detail.baseRef }),
      mergeLabel(picked),
      false,
      () => {
        setPicking(false)
        void run(() => call("github.merge", { url: detail.url, method: picked }))
      },
    )
  }

  if (!canMerge && detail.status !== "draft") return null
  return (
    <View style={styles.section}>
      {error !== null && <Notice tone="danger" text={error} />}
      {canMerge && (
        <Button
          testID="pull-request-merge"
          label={copy("mobile_pr_merge")}
          icon="RiGitMergeLine"
          variant="primary"
          busy={busy}
          onPress={() => setPicking(true)}
        />
      )}
      {detail.status === "draft" && (
        <Text style={[styles.hint, { color: theme.textMuted }]}>{copy("mobile_pr_merge_blocked_draft")}</Text>
      )}
      <Sheet title={copy("mobile_pr_merge_method")} open={picking} onClose={() => setPicking(false)} fit>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={copy("mobile_pr_merge_method")}
          style={styles.methods}
        >
          {mergeMethods.map((option) => (
            <OptionRow
              key={option}
              label={mergeLabel(option)}
              icon="RiGitMergeLine"
              selected={option === method}
              onPress={() => pickMethod(option)}
            />
          ))}
        </View>
      </Sheet>
    </View>
  )
}

/** A setting more than an action, so it is a switch. It shows the new value at once while the server catches up. */
function WatchRow({ url, threadId, watching }: { url: string; threadId: string; watching: boolean }) {
  const theme = useTheme()
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  const change = async (watch: boolean) => {
    setPending(watch)
    setError(null)
    try {
      await (watch ? call("pullRequests.watch", { threadId, url }) : call("pullRequests.unwatch", { threadId, url }))
    } catch (cause) {
      setError(errorText(cause))
    }
    setPending(null)
  }

  return (
    <View style={styles.section}>
      <View style={styles.watch}>
        <Icon name="RiEyeLine" size={18} color={theme.text} />
        <View style={styles.watchText}>
          <Text style={[styles.watchLabel, { color: theme.text }]}>{copy("mobile_pr_watch")}</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{copy("mobile_pr_watch_hint")}</Text>
        </View>
        <Toggle
          accessibilityLabel={copy("mobile_pr_watch")}
          accessibilityHint={copy("mobile_pr_watch_hint")}
          value={pending ?? watching}
          disabled={pending !== null}
          onValueChange={(watch) => void change(watch)}
        />
      </View>
      {error !== null && <Notice tone="danger" text={error} />}
    </View>
  )
}

/** Rare and destructive, so it waits at the end of the page, away from Merge. */
function CloseButton({ detail, onChanged }: { detail: PullRequestDetail; onChanged: () => Promise<void> }) {
  const { busy, error, run } = useGitHubAction(detail.url, onChanged)
  const close = () =>
    confirm(
      copy("mobile_pr_close_title", { number: String(detail.number) }),
      copy("mobile_pr_close_body"),
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
  page: { padding: 16, flexGrow: 1 },
  /** A readable measure when the screen is wide, as in an iPad pane. */
  column: { width: "100%", maxWidth: 760, alignSelf: "center", gap: 20 },
  tabs: { borderBottomWidth: StyleSheet.hairlineWidth, marginTop: -8 },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 32 },
  header: { gap: 8 },
  title: { fontSize: 18, fontWeight: "600", lineHeight: 24 },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 4 },
  metaText: { fontSize: 13 },
  branches: { flexShrink: 1, fontFamily: mono, fontSize: 12 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  section: { gap: 8 },
  blockTitle: { fontSize: 13, fontWeight: "600" },
  ask: { gap: 8, alignItems: "flex-start" },
  sent: { flexDirection: "row", alignItems: "center", gap: 6 },
  run: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: 10 },
  runName: { flex: 1, fontSize: 14, lineHeight: 19, paddingVertical: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  hint: { fontSize: 13, lineHeight: 18 },
  methods: { gap: 2 },
  watch: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: 12 },
  watchText: { flex: 1, gap: 2 },
  watchLabel: { fontSize: 15, fontWeight: "500" },
  close: { alignSelf: "flex-start", marginLeft: -12 },
})
