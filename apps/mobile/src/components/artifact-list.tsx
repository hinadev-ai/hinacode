import type { Artifact, ArtifactKind } from "@shared/artifact.ts"
import { router, useFocusEffect } from "expo-router"
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { GroupedCard } from "@/components/grouped-card"
import { Icon, type IconName } from "@/components/icon"
import { Spinner } from "@/components/motion"
import { EmptyState, Notice } from "@/components/ui"
import { HIT, READABLE_WIDTH } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useTheme } from "@/hooks/use-theme"
import { call, onEvent, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { relativeTime } from "@/lib/relative-time"
import { useThreads } from "@/stores/threads"

type Loaded =
  | { status: "loading" }
  | { status: "ready"; artifacts: readonly Artifact[] }
  | { status: "error"; message: string }

const kindIcon: Record<ArtifactKind, IconName> = { page: "Layout", document: "FileText", whiteboard: "Flow" }

const kindLabel = (kind: ArtifactKind) =>
  copy(
    kind === "document"
      ? "mobile_artifact_card_document"
      : kind === "whiteboard"
        ? "mobile_artifacts_whiteboard"
        : "mobile_artifact_card_page",
  )

const newestFirst = (artifacts: readonly Artifact[]) =>
  [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

const shown = (artifacts: readonly Artifact[], threadId: string | undefined) =>
  threadId === undefined ? artifacts : artifacts.filter((artifact) => artifact.threadId === threadId)

/** Reads every server's artifacts. A failed read keeps the list already shown. */
async function loadInto(setState: Dispatch<SetStateAction<Loaded>>) {
  try {
    const artifacts = newestFirst(await call("artifacts.list", undefined))
    setState({ status: "ready", artifacts })
  } catch (cause) {
    setState((current) => (current.status === "ready" ? current : { status: "error", message: errorText(cause) }))
  }
}

/**
 * The artifacts the paired desktops published, newest first, or only `threadId`'s. Documents open here; pages and
 * whiteboards open on the desktop.
 */
export function ArtifactList({ threadId }: { threadId?: string }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const [state, setState] = useState<Loaded>({ status: "loading" })
  const [refreshing, setRefreshing] = useState(false)

  useFocusEffect(
    useCallback(() => {
      if (connected) void loadInto(setState)
    }, [connected]),
  )

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "artifact.updated" || event.type === "artifact.removed") void loadInto(setState)
      }),
    [],
  )

  const refresh = async () => {
    setRefreshing(true)
    try {
      await loadInto(setState)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <ScrollView
      testID={threadId === undefined ? "artifacts" : "thread-artifacts"}
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
        {state.status === "loading" ? (
          connected && (
            <View style={styles.loading}>
              <Spinner color={theme.textMuted} />
            </View>
          )
        ) : state.status === "error" ? (
          <Notice tone="danger" text={state.message} />
        ) : shown(state.artifacts, threadId).length === 0 ? (
          <EmptyState icon="Layout" title={copy("mobile_artifacts_empty")} hint={copy("mobile_artifacts_empty_hint")} />
        ) : (
          <GroupedCard>
            {shown(state.artifacts, threadId).map((artifact) => (
              <ArtifactRow key={artifact.id} artifact={artifact} showThread={threadId === undefined} />
            ))}
          </GroupedCard>
        )}
      </View>
    </ScrollView>
  )
}

function ArtifactRow({ artifact, showThread }: { artifact: Artifact; showThread: boolean }) {
  const theme = useTheme()
  const now = useNow()
  const kind = artifact.kind ?? "page"
  const thread = useThreads((state) => (artifact.threadId === undefined ? undefined : state.byId[artifact.threadId]))
  const threadId = artifact.threadId
  const openable = kind === "document" && threadId !== undefined
  const meta = [
    kindLabel(kind),
    copy("mobile_artifact_card_version", { version: String(artifact.version) }),
    relativeTime(artifact.updatedAt, now),
  ].join(" · ")

  return (
    <Pressable
      testID="artifact-row"
      accessibilityRole={openable ? "button" : undefined}
      accessibilityLabel={[artifact.title, meta, thread?.title].filter(Boolean).join(", ")}
      disabled={!openable}
      onPress={() =>
        openable &&
        router.push({
          pathname: "/thread/[id]/document",
          params: { id: threadId, artifactId: artifact.id, title: artifact.title },
        })
      }
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <View style={styles.rowIcon}>
        <Icon name={kindIcon[kind]} size={18} color={theme.text} />
      </View>
      <View style={styles.rowBody}>
        <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
          {artifact.title || copy("mobile_artifact_untitled_page")}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: theme.textMuted }]}>
          {meta}
        </Text>
        {showThread && thread !== undefined && (
          <View style={styles.thread}>
            <Icon name="Chat" size={13} color={theme.textMuted} />
            <Text numberOfLines={1} style={[styles.meta, styles.threadTitle, { color: theme.textMuted }]}>
              {thread.title || copy("mobile_home_untitled")}
            </Text>
          </View>
        )}
      </View>
      {openable && <Icon name="ChevronRight" size={16} color={theme.textMuted} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 },
  column: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center", gap: 4 },
  loading: { alignItems: "center", paddingVertical: 24 },
  row: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowIcon: { alignSelf: "flex-start", paddingTop: 2 },
  rowBody: { flex: 1, gap: 4, minWidth: 0 },
  title: { fontSize: 16, lineHeight: 22, fontWeight: "500" },
  meta: { fontSize: 13, lineHeight: 18 },
  thread: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 },
  threadTitle: { flexShrink: 1 },
})
