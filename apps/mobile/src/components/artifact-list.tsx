import { useAtomValue } from "@effect/atom-react"
import type { Artifact } from "@shared/artifact.ts"
import { Cause, Effect, Option } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { useFocusEffect } from "expo-router"
import { useState, useTransition } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { GroupedCard } from "@/components/grouped-card"
import { Icon } from "@/components/icon"
import { Spinner } from "@/components/motion"
import { Button, EmptyState, Notice } from "@/components/ui"
import { HIT, READABLE_WIDTH } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useThreadConnection, useThreadServer } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { artifactKinds, openArtifact } from "@/lib/artifact-kinds"
import { call, type RpcError, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { relativeTime } from "@/lib/relative-time"
import { registry, rpcFamily } from "@/lib/remote"
import { useThreads } from "@/stores/threads"

type Loaded =
  | { status: "loading" }
  | { status: "ready"; artifacts: readonly Artifact[] }
  | { status: "error"; message: string }

const newestFirst = (artifacts: readonly Artifact[]) =>
  [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

const shown = (artifacts: readonly Artifact[], threadId: string | undefined) =>
  threadId === undefined ? artifacts : artifacts.filter((artifact) => artifact.threadId === threadId)

const artifactsAtom = rpcFamily("artifacts.list", {
  refreshOn: (event) => event.type === "artifact.updated" || event.type === "artifact.removed",
})

const loaded = (result: AsyncResult.AsyncResult<readonly Artifact[], RpcError>): Loaded => {
  const artifacts = AsyncResult.value(result)
  if (Option.isSome(artifacts)) return { status: "ready", artifacts: newestFirst(artifacts.value) }
  if (AsyncResult.isFailure(result)) return { status: "error", message: errorText(Cause.squash(result.cause)) }
  return { status: "loading" }
}

export function ArtifactList({ threadId }: { threadId?: string }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const read = artifactsAtom(undefined)
  const result = useAtomValue(read)
  const state = loaded(result)
  const [refreshing, setRefreshing] = useState(false)

  useFocusEffect(() => {
    if (AsyncResult.isNotInitial(registry.get(read))) registry.refresh(read)
  })

  const refresh = () => {
    setRefreshing(true)
    registry.refresh(read)
    return Effect.runPromise(Effect.ignore(AtomRegistry.getResult(registry, read, { suspendOnWaiting: true }))).finally(
      () => setRefreshing(false),
    )
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
        {threadId !== undefined && <NewDocument threadId={threadId} />}
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
  const openable = threadId !== undefined
  const meta = [
    artifactKinds[kind].label,
    copy("mobile_artifact_card_version", { version: String(artifact.version) }),
    relativeTime(artifact.updatedAt, now),
  ].join(" · ")

  return (
    <Pressable
      testID="artifact-row"
      accessibilityRole={openable ? "button" : undefined}
      accessibilityLabel={[artifact.title, meta, thread?.title].filter(Boolean).join(", ")}
      disabled={!openable}
      onPress={() => openable && openArtifact(threadId, { id: artifact.id, kind, title: artifact.title })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <View style={styles.rowIcon}>
        <Icon name={artifactKinds[kind].icon} size={18} color={theme.text} />
      </View>
      <View style={styles.rowBody}>
        <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
          {artifact.title || artifactKinds[kind].untitled}
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

function NewDocument({ threadId }: { threadId: string }) {
  const server = useThreadServer(threadId)?.id
  const connected = useThreadConnection(threadId) === "connected"
  const [creating, startCreating] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)
  const create = () =>
    startCreating(async () => {
      setFailure(null)
      try {
        const title = copy("mobile_artifact_untitled_document")
        const created = await call("artifacts.createDocument", { threadId, title }, { server })
        openArtifact(threadId, { id: created.id, kind: "document", title: created.title })
      } catch (cause) {
        setFailure(copy("mobile_artifacts_create_failed", { message: errorText(cause) }))
      }
    })
  return (
    <View style={styles.create}>
      <Button
        testID="new-document"
        label={copy("mobile_artifacts_new_document")}
        icon="FileText"
        busy={creating}
        disabled={!connected}
        onPress={create}
      />
      {failure !== null && <Notice tone="danger" text={failure} />}
    </View>
  )
}

const styles = StyleSheet.create({
  create: { gap: 8, paddingBottom: 8 },
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
