import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { PushEvent } from "@shared/contract.ts"
import { Cause, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import type { CalloutTone } from "@shared/documentCallout.ts"
import type { Thread } from "@shared/domain.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { useEffect, useEffectEvent, useState } from "react"
import { ActivityIndicator, FlatList, Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Failure } from "@/components/files"
import { Icon, type IconName } from "@/components/icon"
import { Markdown } from "@/components/markdown"
import { EmptyState, Notice } from "@/components/ui"
import { CalloutColors, READABLE_WIDTH, radius } from "@/constants/theme"
import { useThreadConnection, useThreadServer } from "@/hooks/use-server"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { onEvent } from "@/lib/connection"
import { rpcFamily } from "@/lib/remote"
import { copy } from "@/lib/copy"
import { type DocumentSegment, documentSegments } from "@/lib/document-segments"
import { errorText } from "@/lib/error-text"
import { useThreadRoot, useThreads } from "@/stores/threads"

type Params = { id: string; artifactId: string; title?: string }

const PADDING = 16
// FIXME: The Markdown renderer trims a segment's last margin, so the space between segments lives here.
const SEGMENT_GAP = 14
const TITLE_INSET = 120

const calloutCopy = {
  note: { label: "mobile_document_callout_note", icon: "Info" },
  tip: { label: "mobile_document_callout_tip", icon: "RiLightbulbLine" },
  important: { label: "mobile_document_callout_important", icon: "RiFeedbackLine" },
  warning: { label: "mobile_document_callout_warning", icon: "Alert" },
  caution: { label: "mobile_document_callout_caution", icon: "RiSpam2Line" },
} as const satisfies Record<CalloutTone, { label: Parameters<typeof copy>[0]; icon: IconName }>

const documentAtom = rpcFamily("artifacts.readDocument", {
  refreshOn: (event, { id }) => event.type === "artifact.updated" && event.artifact.id === id,
})

export default function DocumentScreen() {
  const theme = useTheme()
  const { id, artifactId, title } = useLocalSearchParams<Params>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  return (
    <SafeAreaView edges={["bottom"]} style={[styles.flex, { backgroundColor: theme.background }]}>
      {thread !== undefined ? (
        <DocumentBody key={artifactId} thread={thread} artifactId={artifactId} initialTitle={title ?? ""} />
      ) : loaded ? (
        <EmptyState icon="Question" title={copy("mobile_thread_missing")} />
      ) : (
        <Loading />
      )}
    </SafeAreaView>
  )
}

function DocumentBody({
  thread,
  artifactId,
  initialTitle,
}: {
  thread: Thread
  artifactId: string
  initialTitle: string
}) {
  const connection = useThreadConnection(thread.id)
  const server = useThreadServer(thread.id)?.id
  const connected = connection === "connected"
  const [title, setTitle] = useState(initialTitle)
  const [removal, setRemoval] = useState<"none" | "removed" | "retrying">("none")
  const read = documentAtom({ id: artifactId }, server)
  const result = useAtomValue(read)
  const refresh = useAtomRefresh(read)
  const settled = !result.waiting
  const content =
    removal === "none"
      ? Option.getOrUndefined(AsyncResult.value(result))
      : removal === "retrying" && settled && AsyncResult.isSuccess(result)
        ? result.value
        : undefined
  const failure =
    removal === "removed"
      ? copy("mobile_document_removed")
      : content === undefined && settled && AsyncResult.isFailure(result)
        ? errorText(Cause.squash(result.cause))
        : null

  const onPush = useEffectEvent((event: PushEvent) => {
    if (event.type === "artifact.updated" && event.artifact.id === artifactId) {
      setTitle(event.artifact.title)
      setRemoval("none")
    }
    if (event.type === "artifact.removed" && event.id === artifactId) setRemoval("removed")
  })
  useEffect(() => onEvent(onPush), [])

  const retry = () => {
    if (removal === "removed") setRemoval("retrying")
    refresh()
  }

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
            <DocumentTitle title={title} version={content?.version ?? null} />
          ),
        }}
      />
      {!connected && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_reconnecting_banner")} tone="attention" />
        </View>
      )}
      {failure !== null ? (
        <Failure message={failure} onRetry={retry} />
      ) : content === undefined ? (
        <Loading />
      ) : (
        <DocumentText thread={thread} markdown={content.markdown} />
      )}
    </>
  )
}

function DocumentTitle({ title, version }: { title: string; version: number | null }) {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  return (
    <View style={[styles.titleRow, { maxWidth: width - TITLE_INSET }]}>
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.text }]}>
        {title}
      </Text>
      {version !== null && (
        <Text style={[styles.version, { color: theme.textMuted }]}>
          {copy("mobile_artifact_card_version", { version: String(version) })}
        </Text>
      )}
    </View>
  )
}

function Loading() {
  const theme = useTheme()
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={theme.textMuted} accessibilityLabel={copy("mobile_document_loading")} />
    </View>
  )
}

function DocumentText({ thread, markdown }: { thread: Thread; markdown: string }) {
  const root = useThreadRoot(thread)
  const segments = documentSegments(markdown)
  if (segments.length === 0) return <EmptyState icon="FileText" title={copy("mobile_document_empty")} />
  return (
    <FlatList
      testID="document"
      style={styles.flex}
      contentContainerStyle={styles.content}
      data={segments}
      keyExtractor={(_, index) => String(index)}
      renderItem={({ item }) => <Segment segment={item} root={root} threadId={thread.id} />}
      ItemSeparatorComponent={SegmentGap}
      initialNumToRender={4}
      maxToRenderPerBatch={2}
      windowSize={9}
    />
  )
}

function SegmentGap() {
  return <View style={styles.gap} />
}

function Segment({ segment, root, threadId }: { segment: DocumentSegment; root: string | null; threadId: string }) {
  if (segment.kind === "callout") return <Callout segment={segment} root={root} threadId={threadId} />
  return <Markdown text={segment.text} root={root} threadId={threadId} gutter={PADDING} measure="document" />
}

function Callout({
  segment: { tone, text },
  root,
  threadId,
}: {
  segment: Extract<DocumentSegment, { kind: "callout" }>
  root: string | null
  threadId: string
}) {
  const scheme = useScheme()
  const { tint, label } = CalloutColors[scheme][tone]
  const { label: labelKey, icon } = calloutCopy[tone]
  return (
    <View style={[styles.callout, { backgroundColor: tint }]}>
      <View style={styles.calloutLabel}>
        <Icon name={icon} size={14} color={label} />
        <Text style={[styles.calloutLabelText, { color: label }]}>{copy(labelKey)}</Text>
      </View>
      {text !== "" && <Markdown text={text} root={root} threadId={threadId} measure="document" />}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: { paddingHorizontal: 12, paddingTop: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center", padding: PADDING, paddingBottom: 32 },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    alignSelf: Platform.OS === "ios" ? "center" : "flex-start",
  },
  title: { flexShrink: 1, fontSize: 16, fontWeight: "600" },
  version: { fontSize: 13, fontVariant: ["tabular-nums"] },
  gap: { height: SEGMENT_GAP },
  callout: { borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  calloutLabel: { flexDirection: "row", alignItems: "center", gap: 6 },
  calloutLabelText: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
})
