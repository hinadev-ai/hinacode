import { useAtomMount, useAtomValue } from "@effect/atom-react"
import type { PullRequest, PullRequestLink, Thread } from "@shared/domain.ts"
import { Effect } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { router } from "expo-router"
import { useState } from "react"
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
} from "@/lib/pull-request-labels"
import { LineCounts } from "@/components/pull-request-code"
import { PullRequestState } from "@/components/pull-request-state"
import { Button, EmptyState, Notice, Pill } from "@/components/ui"
import { mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { pullRequestReference } from "@/lib/overview"
import { familyOf, handshakes, registry } from "@/lib/remote"
import { loadPullRequestAtom, usePullRequests } from "@/stores/pull-requests"
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

const NOT_READ: { readonly error: string | null; readonly branch: PullRequest | null } = { error: null, branch: null }

const threadPullRequestsAtom = familyOf((threadId: string, worktreeId: string | null) =>
  Atom.make((get) => {
    get(handshakes)
    return Effect.promise(() => readPullRequests(threadId, worktreeId))
  }),
)

/** Every pull request the thread has: the ones linked to it, plus the one GitHub has for its worktree branch. */
export function PullRequests({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const links = usePullRequests((state) => state.linksByThread[thread.id])
  const worktreeId = useThreads((state) => {
    const worktree = thread.worktreeId === null ? undefined : state.worktrees[thread.worktreeId]
    return worktree !== undefined && worktree.status !== "removed" ? worktree.id : null
  })
  const read = threadPullRequestsAtom(thread.id, worktreeId)
  const { error: readError, branch: branchPullRequest } = AsyncResult.getOrElse(useAtomValue(read), () => NOT_READ)
  const [createError, setCreateError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const error = createError ?? readError

  const linked = new Set((links ?? []).map((link) => link.url))
  const branchUrl = branchPullRequest !== null && !linked.has(branchPullRequest.url) ? branchPullRequest.url : null

  const refresh = async () => {
    setRefreshing(true)
    const { loadPullRequest } = usePullRequests.getState()
    const urls = [...linked, ...(branchUrl === null ? [] : [branchUrl])]
    setCreateError(null)
    registry.refresh(read)
    try {
      await Promise.all([
        Effect.runPromise(AtomRegistry.getResult(registry, read, { suspendOnWaiting: true })),
        ...urls.map((url) => loadPullRequest(url, { force: true })),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  const create = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      await call("pullRequests.create", { threadId: thread.id })
    } catch (cause) {
      setCreateError(errorText(cause))
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

  useAtomMount(loadPullRequestAtom(url))

  const watching = (link?.watch ?? null) !== null
  const failed = remote?.status === "error" ? remote.message : null
  const reference = pullRequestReference(url)
  const review = pr !== null && (pr.status === "open" || pr.status === "draft") ? pr.review : null
  const label =
    pr === null
      ? [reference, failed !== null && copy("mobile_pr_card_failed", { message: failed })]
          .filter((part) => typeof part === "string")
          .join(", ")
      : [
          pr.title,
          pullRequestLabel(String(pr.number), pr),
          review !== null && reviewLabel(review),
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
      style={[styles.card, { borderColor: theme.border, backgroundColor: theme.card }]}
    >
      {pr === null ? (
        <View style={styles.titleRow}>
          <View style={styles.titleIcon}>
            {failed === null ? (
              <Icon name="RiGitPullRequestLine" size={18} color={theme.textMuted} />
            ) : (
              <Icon name="Warning" size={18} color={theme.danger} />
            )}
          </View>
          <View style={styles.pending}>
            <Text numberOfLines={2} style={[styles.title, { color: theme.textMuted }]}>
              {reference}
            </Text>
            {failed !== null && (
              <Text numberOfLines={1} style={[styles.note, { color: theme.textMuted }]}>
                {copy("mobile_pr_lookup_failed")}
              </Text>
            )}
          </View>
          {failed === null ? (
            <Reveal style={styles.titleIcon}>
              <Spinner size={14} color={theme.textMuted} />
            </Reveal>
          ) : (
            <Icon name="ChevronRight" size={18} color={theme.textMuted} />
          )}
        </View>
      ) : (
        <>
          <View style={styles.headline}>
            <PullRequestState status={pr.status} />
            <Text style={[styles.number, { color: theme.textMuted }]}>#{pr.number}</Text>
            <LineCounts added={pr.additions} removed={pr.deletions} />
            <View style={styles.spacer} />
            <Icon name="ChevronRight" size={18} color={theme.textMuted} />
          </View>
          <Text numberOfLines={3} style={[styles.title, { color: theme.text }]}>
            {pr.title}
          </Text>
          <Text numberOfLines={1} style={[styles.branches, { color: theme.textMuted }]}>
            {pr.headRefName} → {pr.baseRefName}
          </Text>
          {(pr.checks !== null || review !== null || watching) && (
            <View style={styles.pills}>
              {pr.checks !== null && (
                <Pill label={checksLabel(pr.checks)} tone={checksTone[pr.checks]} icon={checksIcon[pr.checks]} />
              )}
              {review !== null && <Pill label={reviewLabel(review)} tone={reviewTone[review]} />}
              {watching && <Pill label={copy("mobile_pr_watching")} tone="neutral" icon="Eye" />}
            </View>
          )}
        </>
      )}
      {link === null && (
        <Text style={[styles.note, { color: theme.textMuted }]}>{copy("mobile_pr_from_branch")}</Text>
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  // Capped and centered like the pull request screen, so cards keep a readable width on an iPad.
  list: { padding: 16, gap: 12, flexGrow: 1, width: "100%", maxWidth: 792, alignSelf: "center" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 24 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, padding: 16, gap: 8 },
  headline: { flexDirection: "row", alignItems: "center", gap: 10 },
  number: { fontFamily: mono, fontSize: 13 },
  spacer: { flex: 1 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  titleIcon: { paddingTop: 2 },
  title: { flex: 1, fontSize: 17, fontWeight: "600", lineHeight: 23 },
  pending: { flex: 1, gap: 2 },
  branches: { fontFamily: mono, fontSize: 12 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  note: { fontSize: 13, lineHeight: 18 },
})
