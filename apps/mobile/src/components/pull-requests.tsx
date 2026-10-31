import type { PullRequest, PullRequestLink, Thread } from "@shared/domain.ts"
import { router } from "expo-router"
import { useEffect, useState } from "react"
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { PressableScale, Reveal, Spinner } from "@/components/motion"
import {
  checksIcon,
  checksLabel,
  checksTone,
  pullRequestLabel,
  reviewLabel,
  reviewTone,
  statusGlyph,
} from "@/lib/pull-request-labels"
import { PullRequestState } from "@/components/pull-request-state"
import { Button, EmptyState, Notice, Pill } from "@/components/ui"
import { mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { usePullRequests } from "@/stores/pull-requests"
import { useThreads } from "@/stores/threads"

/** Reads the thread's links into the store, and the pull request GitHub has for its worktree branch. */
async function readPullRequests(threadId: string, worktreeId: string | null) {
  const [error, branch] = await Promise.all([
    usePullRequests
      .getState()
      .loadThread(threadId)
      .then(
        () => null,
        (cause: unknown) => errorText(cause),
      ),
    // Without gh, or without a pull request for the branch, there is simply no branch card.
    worktreeId === null ? null : call("worktrees.pullRequest", { id: worktreeId }).catch(() => null),
  ])
  return { error, branch }
}

/** Every pull request the thread has: the ones linked to it, plus the one GitHub has for its worktree branch. */
export function PullRequests({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const links = usePullRequests((state) => state.linksByThread[thread.id])
  const worktreeId = useThreads((state) => {
    const worktree = thread.worktreeId === null ? undefined : state.worktrees[thread.worktreeId]
    return worktree !== undefined && worktree.status !== "removed" ? worktree.id : null
  })
  const [error, setError] = useState<string | null>(null)
  const [branchPullRequest, setBranchPullRequest] = useState<PullRequest | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!connected) return
    let current = true
    void readPullRequests(thread.id, worktreeId).then((result) => {
      if (!current) return
      setError(result.error)
      setBranchPullRequest(result.branch)
    })
    return () => {
      current = false
    }
  }, [connected, thread.id, worktreeId])

  const linked = new Set((links ?? []).map((link) => link.url))
  const branchUrl = branchPullRequest !== null && !linked.has(branchPullRequest.url) ? branchPullRequest.url : null

  const refresh = async () => {
    setRefreshing(true)
    const { loadPullRequest } = usePullRequests.getState()
    const urls = [...linked, ...(branchUrl === null ? [] : [branchUrl])]
    try {
      const [result] = await Promise.all([
        readPullRequests(thread.id, worktreeId),
        ...urls.map((url) => loadPullRequest(url, { force: true })),
      ])
      setError(result.error)
      setBranchPullRequest(result.branch)
    } finally {
      setRefreshing(false)
    }
  }

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      await call("pullRequests.create", { threadId: thread.id })
    } catch (cause) {
      setError(errorText(cause))
    }
    setCreating(false)
  }

  const open = (url: string) => router.push({ pathname: "/thread/[id]/pull-request", params: { id: thread.id, url } })

  return (
    <ScrollView
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.textMuted} />
      }
    >
      {error !== null && <Notice text={copy("mobile_pr_links_failed", { message: error })} tone="danger" />}
      {links === undefined ? (
        error === null && (
          <Reveal style={styles.loading}>
            <Spinner color={theme.textMuted} />
            <Text style={{ color: theme.textMuted }}>{copy("mobile_pr_loading")}</Text>
          </Reveal>
        )
      ) : links.length === 0 && branchUrl === null ? (
        <EmptyState
          icon="RiGitPullRequestLine"
          title={copy("mobile_pr_empty")}
          hint={copy("mobile_pr_empty_hint")}
          action={
            thread.worktreeId !== null && (
              <Button
                testID="create-pull-request"
                label={copy("mobile_pr_create")}
                icon="RiGitPullRequestLine"
                variant="primary"
                busy={creating}
                onPress={() => void create()}
              />
            )
          }
        />
      ) : (
        <>
          {[...links]
            .reverse()
            .map((link) => (
              <PullRequestCard key={link.id} url={link.url} link={link} onPress={() => open(link.url)} />
            ))}
          {branchUrl !== null && <PullRequestCard url={branchUrl} link={null} onPress={() => open(branchUrl)} />}
        </>
      )}
    </ScrollView>
  )
}

function PullRequestCard({
  url,
  link,
  onPress,
}: {
  url: string
  /** Null for the branch's pull request that nobody linked. */
  link: PullRequestLink | null
  onPress: () => void
}) {
  const theme = useTheme()
  const remote = usePullRequests((state) => state.pullRequests[url])
  const pr = remote?.status === "ready" ? remote.value : null

  useEffect(() => {
    void usePullRequests.getState().loadPullRequest(url)
  }, [url])

  const watching = (link?.watch ?? null) !== null
  const label =
    pr === null
      ? url
      : [
          pr.title,
          pullRequestLabel(String(pr.number), pr),
          pr.review !== null && reviewLabel(pr.review),
          watching && copy("mobile_pr_watching"),
        ]
          .filter((part) => typeof part === "string")
          .join(", ")

  return (
    <PressableScale
      testID="pull-request-card"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}
    >
      {pr === null ? (
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.url, { color: theme.textMuted }]}>
            {url}
          </Text>
          {remote?.status !== "error" && (
            <Reveal>
              <Spinner size={14} color={theme.textMuted} />
            </Reveal>
          )}
        </View>
      ) : (
        <>
          <View style={styles.titleRow}>
            <View style={styles.titleIcon}>
              <Icon {...statusGlyph(theme)[pr.status]} size={18} />
            </View>
            <Text numberOfLines={3} style={[styles.title, { color: theme.text }]}>
              {pr.title} <Text style={{ color: theme.textMuted, fontWeight: "400" }}>#{pr.number}</Text>
            </Text>
            <Icon name="RiArrowRightSLine" size={18} color={theme.textMuted} />
          </View>
          <View style={styles.meta}>
            <Text numberOfLines={1} style={[styles.branches, { color: theme.textMuted }]}>
              {pr.headRefName} → {pr.baseRefName}
            </Text>
            <Text
              accessibilityLabel={copy("mobile_pr_size", {
                additions: String(pr.additions),
                deletions: String(pr.deletions),
              })}
              style={styles.size}
            >
              <Text style={{ color: theme.running }}>+{pr.additions}</Text>{" "}
              <Text style={{ color: theme.danger }}>−{pr.deletions}</Text>
            </Text>
          </View>
          <View style={styles.pills}>
            <PullRequestState status={pr.status} />
            {pr.checks !== null && (
              <Pill label={checksLabel(pr.checks)} tone={checksTone[pr.checks]} icon={checksIcon[pr.checks]} />
            )}
            {pr.review !== null && <Pill label={reviewLabel(pr.review)} tone={reviewTone[pr.review]} />}
            {watching && <Pill label={copy("mobile_pr_watching")} tone="neutral" icon="RiEyeLine" />}
          </View>
        </>
      )}
      {link === null && (
        <Text style={[styles.note, { color: theme.textMuted }]}>{copy("mobile_pr_from_branch")}</Text>
      )}
      {remote?.status === "error" && (
        <Text style={[styles.note, { color: theme.danger }]}>
          {copy("mobile_pr_card_failed", { message: remote.message })}
        </Text>
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  // Capped and centered like the pull request screen, so cards keep a readable width on an iPad.
  list: { padding: 16, gap: 12, flexGrow: 1, width: "100%", maxWidth: 792, alignSelf: "center" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 24 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: 14, gap: 8 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  titleIcon: { paddingTop: 2 },
  title: { flex: 1, fontSize: 16, fontWeight: "600", lineHeight: 22 },
  url: { flex: 1, fontSize: 14 },
  meta: { flexDirection: "row", alignItems: "center", gap: 12 },
  branches: { flexShrink: 1, fontFamily: mono, fontSize: 12 },
  size: { fontFamily: mono, fontSize: 12 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  note: { fontSize: 13, lineHeight: 18 },
})
