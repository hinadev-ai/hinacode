import type { DocumentContent } from "@shared/artifact.ts"
import type { CalloutTone } from "@shared/documentCallout.ts"
import { createDocumentSync, type DocumentSync, type SaveStatus } from "@shared/document/sync.ts"
import type { Thread } from "@shared/domain.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { useHeaderHeight } from "expo-router/react-navigation"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import {
  type CodeToken,
  type DocumentAction,
  DocumentEditor,
  type DocumentEditorHandle,
  type DocumentTheme,
  type SelectionState,
} from "@hinacode/document-view"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { DocumentToolbar, LinkSheet } from "@/components/document-toolbar"
import { isMarkToggle, selectionFormats } from "@/lib/document-formats"
import { Failure } from "@/components/files"
import { Icon } from "@/components/icon"
import { Button, EmptyState, IconButton, Notice } from "@/components/ui"
import { CalloutColors, ChartColors, mono, type Palette, radius, SyntaxColors } from "@/constants/theme"
import { useThreadConnection, useThreadServer } from "@/hooks/use-server"
import { type Scheme, useScheme, useTheme } from "@/hooks/use-theme"
import { call, onEvent } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { lex } from "@/lib/lexer"
import { openWebUrl } from "@/lib/open-url"
import { imageDataUrl, pickImages } from "@/lib/stage-images"
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
  const headerHeight = useHeaderHeight()
  const connection = useThreadConnection(thread.id)
  const server = useThreadServer(thread.id)?.id
  const connected = connection === "connected"
  const [title, setTitle] = useState(initialTitle)
  const [version, setVersion] = useState<number | null>(null)
  const [state, setState] = useState<Loaded>({ status: "loading" })
  const latestRead = useRef(0)

  const read = async () => {
    const attempt = ++latestRead.current
    try {
      const document = await call("artifacts.readDocument", { id: artifactId }, { server })
      if (latestRead.current !== attempt) return
      setVersion(document.version)
      setState({ status: "ready", document })
    } catch (cause) {
      if (latestRead.current !== attempt) return
      setState((current) => (current.status === "ready" ? current : { status: "error", message: errorText(cause) }))
    }
  }

  const readUntilLoaded = useEffectEvent(() => {
    if (state.status !== "ready") void read()
  })
  useEffect(() => {
    if (connected) readUntilLoaded()
  }, [connected])

  const onPush = useEffectEvent((event: Parameters<Parameters<typeof onEvent>[0]>[0]) => {
    if (event.type === "artifact.updated" && event.artifact.id === artifactId) {
      setTitle(event.artifact.title)
      setVersion(event.artifact.version)
      readUntilLoaded()
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
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      {state.status !== "ready" && (
        <Stack.Screen
          options={{
            title,
            headerTitle: () => <DocumentTitle title={title} version={version} status={{ type: "saved" }} />,
            headerRight: undefined,
          }}
        />
      )}
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
        <DocumentEditing
          artifactId={artifactId}
          server={server}
          title={title}
          version={version}
          loaded={state.document}
          connected={connected}
        />
      )}
    </KeyboardAvoidingView>
  )
}

function ConflictBanner({ sync }: { sync: DocumentSync }) {
  const theme = useTheme()
  return (
    <View
      accessibilityRole="alert"
      style={[styles.conflict, { backgroundColor: theme.attentionBg, borderColor: theme.border }]}
    >
      <View style={styles.conflictText}>
        <Icon name="Warning" size={16} color={theme.attention} />
        <Text style={[styles.conflictMessage, { color: theme.text }]}>{copy("mobile_document_conflict")}</Text>
      </View>
      <View style={styles.conflictActions}>
        <Button
          testID="document-use-theirs"
          label={copy("mobile_document_use_theirs")}
          onPress={sync.useTheirs}
          style={styles.conflictAction}
        />
        <Button
          testID="document-keep-mine"
          label={copy("mobile_document_keep_mine")}
          variant="primary"
          onPress={() => void sync.keepMine()}
          style={styles.conflictAction}
        />
      </View>
    </View>
  )
}

function DocumentTitle({ title, version, status }: { title: string; version: number | null; status: SaveStatus }) {
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
      <View style={styles.savingSlot}>
        {status.type === "saving" && (
          <ActivityIndicator
            testID="document-saving"
            size="small"
            color={theme.textMuted}
            accessibilityLabel={copy("mobile_document_saving")}
          />
        )}
      </View>
      {(status.type === "conflict" || status.type === "failed") && (
        <Text
          testID="document-save-status"
          accessibilityLiveRegion="polite"
          style={[styles.version, { color: theme.danger }]}
        >
          {copy("mobile_document_not_saved")}
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

function DocumentEditing({
  artifactId,
  server,
  title,
  version,
  loaded,
  connected,
}: {
  artifactId: string
  server: string | undefined
  title: string
  version: number | null
  loaded: DocumentContent
  connected: boolean
}) {
  const theme = useTheme()
  const scheme = useScheme()
  const editor = useRef<DocumentEditorHandle | null>(null)
  const live = useRef(false)
  const started = useRef(false)
  const [status, setStatus] = useState<SaveStatus>({ type: "saved" })
  const [sync] = useState(() =>
    createDocumentSync({
      key: JSON.stringify([server ?? null, artifactId]),
      loaded,
      onStatus: setStatus,
      describe: errorText,
      rpc: {
        save: ({ baseRevision, markdown }) =>
          call("artifacts.saveDocument", { id: artifactId, baseRevision, markdown }, { server }),
        read: () => call("artifacts.readDocument", { id: artifactId }, { server }),
      },
    }),
  )
  const [document, setDocument] = useState({ revision: loaded.revision, markdown: sync.initial })
  const [lossy, setLossy] = useState(false)
  const [focused, setFocused] = useState(false)
  const [selection, setSelection] = useState<SelectionState | null>(null)
  const [linking, setLinking] = useState<{ readonly href: string | null } | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const editable = connected && !lossy
  const [shownScheme, setShownScheme] = useState(scheme)
  if (shownScheme !== scheme) {
    setShownScheme(scheme)
    setDocument((current) => ({
      revision: current.revision + 1,
      markdown: editor.current?.getMarkdown() ?? current.markdown,
    }))
  }

  useEffect(() => {
    live.current = true
    const stop = onEvent((event) => {
      if (event.type === "artifact.updated" && event.artifact.id === artifactId)
        void sync.published(event.artifact.revision)
    })
    return () => {
      stop()
      sync.flush()
      live.current = false
    }
  }, [sync, artifactId])

  const catchUpOnReconnect = useEffectEvent(() => void sync.published())
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (connected && !wasConnected.current) catchUpOnReconnect()
    wasConnected.current = connected
  }, [connected])

  const startSync = () => {
    if (started.current) return
    started.current = true
    sync.start({
      markdown: () => editor.current?.getMarkdown() ?? "",
      load: (markdown) => setDocument((current) => ({ revision: current.revision + 1, markdown })),
      live: () => live.current,
    })
  }

  const run = (action: DocumentAction) => void editor.current?.run(action)

  const openLink = () => setLinking({ href: selection?.href ?? null })

  const saveLink = (href: string | null) => {
    setLinking(null)
    run({ type: "setLink", href })
  }

  const insertImages = async () => {
    setImageError(null)
    setImageBusy(true)
    try {
      for (const asset of await pickImages()) {
        const { dataUrl } = await imageDataUrl(asset)
        const { path } = await call("artifacts.addDocumentImage", { id: artifactId, dataUrl }, { server })
        await editor.current?.run({ type: "insertImage", src: path, alt: "" })
      }
    } catch (cause) {
      setImageError(copy("mobile_document_image_failed", { message: errorText(cause) }))
    } finally {
      setImageBusy(false)
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerTitle: () => <DocumentTitle title={title} version={version} status={status} />,
          headerRight:
            status.type === "failed"
              ? () => (
                  <IconButton
                    testID="document-save-retry"
                    icon="Refresh"
                    accessibilityLabel={copy("mobile_document_retry")}
                    onPress={() => void sync.retry()}
                  />
                )
              : undefined,
        }}
      />
      {status.type === "conflict" && <ConflictBanner sync={sync} />}
      {lossy && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_document_read_only")} />
        </View>
      )}
      {imageError !== null && (
        <View style={styles.banner}>
          <Notice text={imageError} tone="danger" />
        </View>
      )}
      <DocumentEditor
        key={shownScheme}
        ref={(handle) => {
          if (handle !== null) editor.current = handle
        }}
        testID="document"
        style={styles.flex}
        document={document}
        editable={editable}
        theme={documentTheme(theme, shownScheme)}
        highlightCode={highlighter(shownScheme)}
        resolveImage={async (path) => (await call("artifacts.file", { id: artifactId, path }, { server })).dataUrl}
        onLinkPress={openWebUrl}
        onLoaded={() => {
          setLossy(false)
          startSync()
        }}
        onError={(error) => {
          if (error.kind === "lossy") setLossy(true)
        }}
        onChange={() => {
          setImageError(null)
          sync.edited()
        }}
        onSelectionChange={setSelection}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        formatActions={selectionFormats}
        onFormat={(type) => {
          if (type === "setLink") openLink()
          else if (isMarkToggle(type)) run({ type })
        }}
      />
      {focused && editable && (
        <DocumentToolbar
          selection={selection}
          imageBusy={imageBusy}
          onRun={run}
          onImage={() => void insertImages()}
          onLink={openLink}
        />
      )}
      {linking !== null && <LinkSheet href={linking.href} onSave={saveLink} onClose={() => setLinking(null)} />}
    </>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: { paddingHorizontal: 12, paddingTop: 8 },
  conflict: { gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  conflictText: { flexDirection: "row", alignItems: "center", gap: 8 },
  conflictMessage: { flex: 1, fontSize: 14, lineHeight: 20 },
  conflictActions: { flexDirection: "row", gap: 8 },
  conflictAction: { flex: 1, borderRadius: radius.full },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    alignSelf: Platform.OS === "ios" ? "center" : "flex-start",
  },
  title: { flexShrink: 1, fontSize: 16, fontWeight: "600" },
  version: { fontSize: 13, fontVariant: ["tabular-nums"] },
  savingSlot: { width: 20, height: 20, alignSelf: "center", alignItems: "center", justifyContent: "center" },
})
