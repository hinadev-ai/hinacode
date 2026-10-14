import type { PullRequest, PullRequestLink, Thread } from "@shared/domain.ts"
import { openURL } from "expo-linking"
import { useEffect, useState } from "react"
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Button, EmptyState, Notice, Pill } from "@/components/ui"
import { type Palette, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, onEvent, useConnection } from "@/lib/connection"
import { errorText } from "@/lib/error-text"

export function PullRequests({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const [links, setLinks] = useState<readonly PullRequestLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!connected) return
    let current = true
    call("pullRequests.list", { threadId: thread.id }).then(
      (result) => current && setLinks(result),
      (cause) => current && setError(errorText(cause)),
    )
    const unsubscribe = onEvent((event) => {
      if (event.type === "thread.pullRequests" && event.threadId === thread.id) setLinks(event.links)
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [connected, thread.id])

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

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {error !== null && <Notice text={error} tone="danger" />}
      {links === null ? (
        error === null && <ActivityIndicator color={theme.textMuted} accessibilityLabel="Loading pull requests" />
      ) : links.length === 0 ? (
        <EmptyState
          icon="RiGitPullRequestLine"
          title="No pull request is linked to this thread."
          action={
            thread.worktreeId !== null && (
              <Button
                testID="create-pull-request"
                label="Create pull request"
                icon="RiGitPullRequestLine"
                variant="primary"
                busy={creating}
                onPress={() => void create()}
              />
            )
          }
        />
      ) : (
        links.map((link) => <PullRequestCard key={link.id} url={link.url} />)
      )}
    </ScrollView>
  )
}

const statusTone = { open: "running", draft: "neutral", merged: "neutral", closed: "danger" } as const
const statusLabel = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } as const
const checksLabel = { passing: "Checks passing", failing: "Checks failing", pending: "Checks running" } as const
const checksTone = { passing: "running", failing: "danger", pending: "attention" } as const
const checksIcon = { passing: "RiCheckLine", failing: "RiErrorWarningLine", pending: "RiLoader4Line" } as const
const statusIcon = (theme: Palette): Record<PullRequest["status"], { name: IconName; color: string }> => ({
  open: { name: "RiGitPullRequestLine", color: theme.running },
  draft: { name: "RiGitPullRequestLine", color: theme.textMuted },
  merged: { name: "RiGitMergeLine", color: theme.textMuted },
  closed: { name: "RiCloseLine", color: theme.danger },
})
const reviewLabel = { approved: "Approved", changesRequested: "Changes requested", reviewRequired: "Review required" }

function PullRequestCard({ url }: { url: string }) {
  const theme = useTheme()
  const [pr, setPr] = useState<PullRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let current = true
    call("github.pullRequest", { url }).then(
      (result) => current && setPr(result),
      (cause) => current && setError(errorText(cause)),
    )
    return () => {
      current = false
    }
  }, [url, revision])

  const merge = async () => {
    setMerging(true)
    setError(null)
    try {
      await call("github.merge", { url, method: "squash" })
      setRevision((value) => value + 1)
    } catch (cause) {
      setError(errorText(cause))
    }
    setMerging(false)
  }

  const confirmMerge = () => {
    const title = `Squash and merge #${pr?.number ?? ""}?`
    // Alert.alert has no buttons on react-native-web.
    if (Platform.OS === "web") {
      if (window.confirm(title)) void merge()
      return
    }
    Alert.alert(title, pr?.title, [
      { text: "Cancel", style: "cancel" },
      { text: "Merge", style: "destructive", onPress: () => void merge() },
    ])
  }

  return (
    <View
      testID="pull-request-card"
      style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}
    >
      {pr === null ? (
        <Text numberOfLines={1} style={{ color: theme.textMuted }}>
          {url}
        </Text>
      ) : (
        <>
          <View style={styles.titleRow}>
            <View style={styles.titleIcon}>
              <Icon {...statusIcon(theme)[pr.status]} size={18} />
            </View>
            <Text style={[styles.title, { color: theme.text }]}>
              {pr.title} <Text style={{ color: theme.textMuted }}>#{pr.number}</Text>
            </Text>
          </View>
          <Text numberOfLines={1} style={{ color: theme.textMuted, fontSize: 13 }}>
            {pr.headRefName} into {pr.baseRefName}, +{pr.additions} -{pr.deletions}
          </Text>
          <View style={styles.pills}>
            <Pill label={statusLabel[pr.status]} tone={statusTone[pr.status]} />
            {pr.checks !== null && (
              <Pill label={checksLabel[pr.checks]} tone={checksTone[pr.checks]} icon={checksIcon[pr.checks]} />
            )}
            {pr.review !== null && (
              <Pill label={reviewLabel[pr.review]} tone={pr.review === "changesRequested" ? "attention" : "neutral"} />
            )}
          </View>
        </>
      )}
      {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
      <View style={styles.actions}>
        <Button label="Open on GitHub" icon="RiExternalLinkLine" onPress={() => void openURL(url)} />
        {pr?.status === "open" && (
          <Button
            testID="pull-request-merge"
            label="Merge"
            icon="RiGitMergeLine"
            variant="primary"
            busy={merging}
            onPress={confirmMerge}
          />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: 14, gap: 8 },
  titleRow: { flexDirection: "row", gap: 8 },
  titleIcon: { paddingTop: 2 },
  title: { flex: 1, fontSize: 16, fontWeight: "600", lineHeight: 22 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" },
})
