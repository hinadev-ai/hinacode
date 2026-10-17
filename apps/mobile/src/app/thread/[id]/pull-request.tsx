import type { CheckRun, CheckRunStatus, MergeMethod, PullRequestDetail, PullRequestLink } from "@shared/domain.ts"
import { fixChecksPrompt, resolveConflictsPrompt } from "@shared/pullRequestPrompts.ts"
import { openURL } from "expo-linking"
import { Stack, useLocalSearchParams } from "expo-router"
import { type ReactNode, useEffect, useState } from "react"
import { Alert, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Markdown } from "@/components/markdown"
import { PressableScale, Reveal, Spinner } from "@/components/motion"
import { reviewLabel, reviewTone, statusLabel, statusTone } from "@/components/pull-request-badge"
import { OptionRow, Section, Sheet } from "@/components/sheet"
import { Button, Notice, Pill } from "@/components/ui"
import { HIT, mono } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { pullRequestNumber, usePullRequests } from "@/stores/pull-requests"

export default function PullRequestScreen() {
  const theme = useTheme()
  const { id, url } = useLocalSearchParams<{ id: string; url: string }>()
  const connected = useConnection((state) => state.status === "connected")
  const remote = usePullRequests((state) => state.details[url])
  const link = usePullRequests((state) => state.linksByThread[id]?.find((existing) => existing.url === url) ?? null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (connected) void usePullRequests.getState().loadDetail(url)
  }, [connected, url])

  const reload = () => usePullRequests.getState().loadDetail(url, { force: true })
  const refresh = async () => {
    setRefreshing(true)
    await reload()
    setRefreshing(false)
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
      <Stack.Screen options={{ title: number === null ? "" : `#${number}` }} />
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
            <Button
              label={copy("mobile_pr_open_github")}
              icon="RiExternalLinkLine"
              onPress={() => void openURL(url)}
            />
          </View>
        </View>
      ) : (
        <PullRequestView detail={remote.value} threadId={id} link={link} onChanged={reload} />
      )}
    </ScrollView>
  )
}

const isOpen = (detail: PullRequestDetail) => detail.status === "open" || detail.status === "draft"

function PullRequestView({
  detail,
  threadId,
  link,
  onChanged,
}: {
  detail: PullRequestDetail
  threadId: string
  link: PullRequestLink | null
  onChanged: () => Promise<void>
}) {
  const theme = useTheme()
  const conflicting = isOpen(detail) && detail.mergeable === "conflicting"
  const watching = (link?.watch ?? null) !== null
  return (
    <>
      <View style={styles.header}>
        <Text accessibilityRole="header" selectable style={[styles.title, { color: theme.text }]}>
          {detail.title} <Text style={{ color: theme.textMuted, fontWeight: "400" }}>#{detail.number}</Text>
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
          <Pill label={statusLabel(detail.status)} tone={statusTone[detail.status]} />
          {detail.review !== null && <Pill label={reviewLabel(detail.review)} tone={reviewTone[detail.review]} />}
          {isOpen(detail) && detail.mergeable === "mergeable" && (
            <Pill label={copy("mobile_pr_mergeable")} tone="neutral" icon="RiCheckLine" />
          )}
          {conflicting && <Pill label={copy("mobile_pr_conflicting")} tone="attention" icon="RiErrorWarningLine" />}
          {watching && <Pill label={copy("mobile_pr_watching")} tone="neutral" icon="RiEyeLine" />}
        </View>
      </View>
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
      <Actions detail={detail} threadId={threadId} watching={watching} onChanged={onChanged} />
      <Checks detail={detail} threadId={threadId} />
      <Block title={copy("mobile_pr_description")}>
        {detail.body.trim() === "" ? (
          <Text style={{ color: theme.textMuted, fontSize: 14 }}>{copy("mobile_pr_no_description")}</Text>
        ) : (
          <Markdown text={detail.body} root={null} />
        )}
      </Block>
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
          {runs.map((run, index) => (
            <CheckRow key={`${index}:${run.name}`} run={run} />
          ))}
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

const runLabel = (status: CheckRunStatus) => copy(`mobile_pr_check_${status}`)

function CheckRow({ run }: { run: CheckRun }) {
  const theme = useTheme()
  const glyphs: Record<Exclude<CheckRunStatus, "pending">, { name: IconName; color: string }> = {
    passing: { name: "RiCheckboxCircleFill", color: theme.running },
    failing: { name: "RiCloseCircleLine", color: theme.danger },
    skipped: { name: "RiIndeterminateCircleLine", color: theme.textMuted },
  }
  const content = (
    <>
      {run.status === "pending" ? (
        <Spinner size={16} color={theme.attention} />
      ) : (
        <Icon {...glyphs[run.status]} size={16} />
      )}
      <Text
        numberOfLines={1}
        style={[styles.runName, { color: run.status === "failing" ? theme.text : theme.textMuted }]}
      >
        {run.name}
      </Text>
      {run.url !== null && <Icon name="RiExternalLinkLine" size={14} color={theme.textMuted} />}
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
      onPress={() => void openURL(url)}
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

function Actions({
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
  const [picking, setPicking] = useState(false)
  const [method, setMethod] = useState<MergeMethod>("squash")
  const [busy, setBusy] = useState<"merge" | "close" | "watch" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = isOpen(detail)
  const canMerge = detail.status === "open" && detail.mergeable !== "conflicting"
  const number = String(detail.number)

  const run = async (kind: "merge" | "close" | "watch", action: () => Promise<unknown>) => {
    setBusy(kind)
    setError(null)
    try {
      await action()
      if (kind !== "watch") {
        await Promise.all([onChanged(), usePullRequests.getState().loadPullRequest(detail.url, { force: true })])
      }
    } catch (cause) {
      setError(errorText(cause))
    }
    setBusy(null)
  }

  const pickMethod = (picked: MergeMethod) => {
    setMethod(picked)
    confirm(
      copy("mobile_pr_merge_title", { method: mergeLabel(picked), number }),
      copy("mobile_pr_merge_body", { head: detail.headRef, base: detail.baseRef }),
      mergeLabel(picked),
      false,
      () => {
        setPicking(false)
        void run("merge", () => call("github.merge", { url: detail.url, method: picked }))
      },
    )
  }

  const close = () =>
    confirm(
      copy("mobile_pr_close_title", { number }),
      copy("mobile_pr_close_body"),
      copy("mobile_pr_close_confirm"),
      true,
      () => void run("close", () => call("github.close", { url: detail.url })),
    )

  const toggleWatch = () =>
    run("watch", () =>
      watching
        ? call("pullRequests.unwatch", { threadId, url: detail.url })
        : call("pullRequests.watch", { threadId, url: detail.url }),
    )

  return (
    <View style={styles.section}>
      {error !== null && <Notice tone="danger" text={error} />}
      <View style={styles.actions}>
        {canMerge && (
          <Button
            testID="pull-request-merge"
            label={copy("mobile_pr_merge")}
            icon="RiGitMergeLine"
            variant="primary"
            busy={busy === "merge"}
            disabled={busy !== null}
            onPress={() => setPicking(true)}
          />
        )}
        {open && (
          <Button
            label={copy("mobile_pr_close")}
            icon="RiGitClosePullRequestLine"
            variant="danger"
            busy={busy === "close"}
            disabled={busy !== null}
            onPress={close}
          />
        )}
        <Button
          label={copy("mobile_pr_open_github")}
          icon="RiExternalLinkLine"
          onPress={() => void openURL(detail.url)}
        />
      </View>
      {detail.status === "draft" && (
        <Text style={[styles.hint, { color: theme.textMuted }]}>{copy("mobile_pr_merge_blocked_draft")}</Text>
      )}
      {open && (
        <View style={styles.watch}>
          <Button
            label={watching ? copy("mobile_pr_unwatch") : copy("mobile_pr_watch")}
            icon={watching ? "RiEyeOffLine" : "RiEyeLine"}
            accessibilityHint={copy("mobile_pr_watch_hint")}
            busy={busy === "watch"}
            disabled={busy !== null}
            onPress={() => void toggleWatch()}
          />
          <Text style={[styles.hint, styles.watchHint, { color: theme.textMuted }]}>
            {copy("mobile_pr_watch_hint")}
          </Text>
        </View>
      )}
      <Sheet title={copy("mobile_pr_merge_method")} open={picking} onClose={() => setPicking(false)}>
        <Section title={copy("mobile_pr_merge_method")}>
          {mergeMethods.map((option) => (
            <OptionRow
              key={option}
              label={mergeLabel(option)}
              icon="RiGitMergeLine"
              selected={option === method}
              onPress={() => pickMethod(option)}
            />
          ))}
        </Section>
      </Sheet>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 20, flexGrow: 1 },
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
  runName: { flex: 1, fontSize: 14 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  hint: { fontSize: 13, lineHeight: 18 },
  watch: { flexDirection: "row", alignItems: "center", gap: 12 },
  watchHint: { flex: 1 },
})
