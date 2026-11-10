import type { DocumentContent } from "@shared/artifact.ts"
import type { CalloutTone } from "@shared/documentCallout.ts"
import type { Thread } from "@shared/domain.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { type CodeToken, DocumentEditor, type DocumentTheme } from "@hinacode/document-view"
import { ActivityIndicator, Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Failure } from "@/components/files"
import { EmptyState, Notice } from "@/components/ui"
import { CalloutColors, ChartColors, mono, type Palette, SyntaxColors } from "@/constants/theme"
import { useThreadConnection, useThreadServer } from "@/hooks/use-server"
import { type Scheme, useScheme, useTheme } from "@/hooks/use-theme"
import { call, onEvent } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { lex } from "@/lib/lexer"
import { openWebUrl } from "@/lib/open-url"
import { useThreads } from "@/stores/threads"

type Params = { id: string; artifactId: string; title?: string }

const TITLE_INSET = 120

const calloutLabels = {
  note: "mobile_document_callout_note",
  tip: "mobile_document_callout_tip",
  important: "mobile_document_callout_important",
  warning: "mobile_document_callout_warning",
  caution: "mobile_document_callout_caution",
} as const satisfies Record<CalloutTone, Parameters<typeof copy>[0]>

const highlighter =
  (scheme: Scheme) =>
  (code: string, language: string): CodeToken[] =>
    lex(code, `snippet.${language}`).flatMap(({ type, start, end }) =>
      type === "plain" ? [] : [[start, end, SyntaxColors[scheme][type]] as const],
    )

const documentTheme = (theme: Palette, scheme: Scheme): DocumentTheme => ({
  text: theme.text,
  muted: theme.textMuted,
  link: theme.link,
  background: theme.background,
  surface: theme.surface,
  border: theme.border,
  codeBackground: theme.surface,
  codeText: SyntaxColors[scheme].plain,
  accent: theme.primary,
  callouts: CalloutColors[scheme],
  calloutLabels: {
    note: copy(calloutLabels.note),
    tip: copy(calloutLabels.tip),
    important: copy(calloutLabels.important),
    warning: copy(calloutLabels.warning),
    caution: copy(calloutLabels.caution),
  },
  chartLanes: ChartColors[scheme],
  diagram: {
    bg: theme.surface,
    fg: theme.text,
    muted: theme.textMuted,
    line: theme.textMuted,
    surface: theme.background,
    surfaceAlt: theme.surface,
    border: theme.textMuted,
    accent: theme.primary,
    critical: theme.danger,
  },
  fontSize: 16,
  lineHeight: 24,
  monoFont: mono ?? "Menlo",
})

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly document: DocumentContent }
  | { readonly status: "error"; readonly message: string }

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
  const [state, setState] = useState<Loaded>({ status: "loading" })
  const latestRead = useRef(0)

  const read = async () => {
    const attempt = ++latestRead.current
    try {
      const document = await call("artifacts.readDocument", { id: artifactId }, { server })
      if (latestRead.current === attempt) setState({ status: "ready", document })
    } catch (cause) {
      if (latestRead.current !== attempt) return
      setState((current) => (current.status === "ready" ? current : { status: "error", message: errorText(cause) }))
    }
  }

  const readOnConnect = useEffectEvent(() => void read())
  useEffect(() => {
    if (connected) readOnConnect()
  }, [connected])

  const onPush = useEffectEvent((event: Parameters<Parameters<typeof onEvent>[0]>[0]) => {
    if (event.type === "artifact.updated" && event.artifact.id === artifactId) {
      setTitle(event.artifact.title)
      void read()
    }
    if (event.type === "artifact.removed" && event.id === artifactId) {
      latestRead.current++
      setState({ status: "error", message: copy("mobile_document_removed") })
    }
  })
  useEffect(() => onEvent(onPush), [])

  const retry = () => {
    setState({ status: "loading" })
    void read()
  }

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
            <DocumentTitle title={title} version={state.status === "ready" ? state.document.version : null} />
          ),
        }}
      />
      {!connected && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_reconnecting_banner")} tone="attention" />
        </View>
      )}
      {state.status === "error" ? (
        <Failure message={state.message} onRetry={retry} />
      ) : state.status === "loading" ? (
        <Loading />
      ) : (
        <DocumentText artifactId={artifactId} server={server} document={state.document} />
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

function DocumentText({
  artifactId,
  server,
  document,
}: {
  artifactId: string
  server: string | undefined
  document: DocumentContent
}) {
  const theme = useTheme()
  const scheme = useScheme()
  return (
    <DocumentEditor
      key={scheme}
      testID="document"
      style={styles.flex}
      document={document}
      theme={documentTheme(theme, scheme)}
      highlightCode={highlighter(scheme)}
      resolveImage={async (path) => (await call("artifacts.file", { id: artifactId, path }, { server })).dataUrl}
      onLinkPress={openWebUrl}
    />
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: { paddingHorizontal: 12, paddingTop: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    alignSelf: Platform.OS === "ios" ? "center" : "flex-start",
  },
  title: { flexShrink: 1, fontSize: 16, fontWeight: "600" },
  version: { fontSize: 13, fontVariant: ["tabular-nums"] },
})
