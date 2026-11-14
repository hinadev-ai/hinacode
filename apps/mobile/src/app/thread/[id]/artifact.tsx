import { useAtomValue } from "@effect/atom-react"
import type { Artifact, WhiteboardScene } from "@shared/artifact.ts"
import { type ArtifactTheme, artifactThemeStyle } from "@shared/artifactTheme.ts"
import { Cause, Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Stack, useLocalSearchParams } from "expo-router"
import { type ComponentProps, startTransition, useState } from "react"
import { ActivityIndicator, Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { WebView } from "react-native-webview"
import { Failure } from "@/components/files"
import { EmptyState, Notice } from "@/components/ui"
import { ChartColors, type Palette } from "@/constants/theme"
import { useThreadConnection, useThreadServer } from "@/hooks/use-server"
import { type Scheme, useScheme, useTheme } from "@/hooks/use-theme"
import { type StagedPage, stagePage } from "@/lib/artifact-page"
import { onEvent, request, RpcError } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { openWebUrl } from "@/lib/open-url"
import { beforeFirstHandshake, familyOf } from "@/lib/remote"
import { drawWhiteboard, whiteboardHtml } from "@/lib/whiteboard-drawing"
import { useThreads } from "@/stores/threads"

type Params = { id: string; artifactId: string; title?: string }

type Viewable =
  | { readonly kind: "page"; readonly artifact: Artifact; readonly page: StagedPage }
  | { readonly kind: "whiteboard"; readonly artifact: Artifact; readonly scene: WhiteboardScene }

type LoadRequest = Parameters<NonNullable<ComponentProps<typeof WebView>["onShouldStartLoadWithRequest"]>>[0]

const TITLE_INSET = 120

const touches = (id: string) => (event: Parameters<Parameters<typeof onEvent>[0]>[0]) =>
  (event.type === "artifact.updated" && event.artifact.id === id) ||
  (event.type === "artifact.removed" && event.id === id)

const viewableAtom = familyOf((id: string, server: string | null, _attempt: number) =>
  Atom.make((get) => {
    if (beforeFirstHandshake(get)) return Effect.never
    get.addFinalizer(onEvent((event) => touches(id)(event) && get.refreshSelf()))
    const options = server === null ? undefined : { server }
    return Effect.gen(function* () {
      const artifact = (yield* request("artifacts.list", undefined, options)).find((found) => found.id === id)
      if (artifact === undefined) return yield* Effect.fail(new RpcError("NotFound", copy("mobile_artifact_removed")))
      if (artifact.kind === "whiteboard") {
        const { scene } = yield* request("artifacts.readWhiteboard", { id }, options)
        return { kind: "whiteboard", artifact, scene } satisfies Viewable
      }
      const page = yield* Effect.tryPromise({
        try: () => stagePage(artifact, options?.server),
        catch: (cause) => (cause instanceof RpcError ? cause : new RpcError("StageFailed", errorText(cause))),
      })
      return { kind: "page", artifact, page } satisfies Viewable
    })
  }),
)

const pageTheme = (theme: Palette, scheme: Scheme): ArtifactTheme => {
  const lanes = ChartColors[scheme]
  return {
    scheme,
    tokens: {
      "--background": theme.background,
      "--foreground": theme.text,
      "--popover": theme.card,
      "--muted": theme.surface,
      "--muted-foreground": theme.textMuted,
      "--border": theme.border,
      "--input": theme.border,
      "--ring": theme.primary,
      "--primary": theme.text,
      "--primary-foreground": theme.background,
      "--working": theme.primary,
      "--destructive": theme.danger,
      "--attention": theme.attention,
      "--success": theme.running,
      "--graph-lane-0": lanes[5]!,
      "--graph-lane-1": lanes[0]!,
      "--graph-lane-2": lanes[1]!,
      "--graph-lane-3": lanes[2]!,
      "--graph-lane-4": lanes[3]!,
      "--graph-lane-5": lanes[4]!,
      "--radius": "10px",
    },
  }
}

const themeScript = (theme: ArtifactTheme) =>
  `(() => {
  const style = document.createElement("style")
  style.id = "hinacode-theme"
  style.textContent = ${JSON.stringify(artifactThemeStyle(theme))}
  document.documentElement.prepend(style)
})();true;`

const RELOADS_AFTER_CRASH = 2

const staysInPage = (load: LoadRequest, page: StagedPage) => {
  if (load.url.startsWith(page.directory)) return true
  if (/^file:/i.test(load.url)) return false
  if (!load.isTopFrame) return true
  if (load.navigationType === "click" && /^https?:/i.test(load.url)) openWebUrl(load.url)
  return false
}

export default function ArtifactScreen() {
  const theme = useTheme()
  const { id, artifactId, title } = useLocalSearchParams<Params>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  return (
    <SafeAreaView edges={["bottom"]} style={[styles.flex, { backgroundColor: theme.background }]}>
      {thread !== undefined ? (
        <ArtifactBody key={artifactId} threadId={id} artifactId={artifactId} initialTitle={title ?? ""} />
      ) : loaded ? (
        <EmptyState icon="Question" title={copy("mobile_thread_missing")} />
      ) : (
        <Loading />
      )}
    </SafeAreaView>
  )
}

function ArtifactBody({
  threadId,
  artifactId,
  initialTitle,
}: {
  threadId: string
  artifactId: string
  initialTitle: string
}) {
  const server = useThreadServer(threadId)?.id
  const connected = useThreadConnection(threadId) === "connected"
  const [attempt, setAttempt] = useState(0)
  const result = useAtomValue(viewableAtom(artifactId, server ?? null, attempt))
  const viewable = Option.getOrUndefined(AsyncResult.value(result))
  const failed = AsyncResult.isFailure(result) && !result.waiting
  const title = viewable?.artifact.title ?? initialTitle

  return (
    <View style={styles.flex}>
      <Stack.Screen
        options={{
          title,
          headerTitle: () => <ArtifactTitle title={title} version={viewable?.artifact.version ?? null} />,
        }}
      />
      {!connected && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_reconnecting_banner")} tone="attention" />
        </View>
      )}
      {failed ? (
        <Failure
          message={errorText(Cause.squash(result.cause))}
          onRetry={() => startTransition(() => setAttempt(attempt + 1))}
        />
      ) : viewable === undefined ? (
        <Loading />
      ) : viewable.kind === "page" ? (
        <PageView page={viewable.page} title={title} />
      ) : (
        <WhiteboardView scene={viewable.scene} title={title} />
      )}
    </View>
  )
}

function PageView({ page, title }: { page: StagedPage; title: string }) {
  const theme = useTheme()
  const scheme = useScheme()
  const [crashes, setCrashes] = useState(0)
  const reload = () => startTransition(() => setCrashes(crashes + 1))
  if (crashes > RELOADS_AFTER_CRASH)
    return <Failure message={copy("mobile_artifact_crashed")} onRetry={() => startTransition(() => setCrashes(0))} />
  return (
    <WebView
      key={`${page.entry}:${scheme}:${crashes}`}
      testID="artifact-page"
      accessibilityLabel={title}
      source={{ uri: page.entry }}
      originWhitelist={["file://*", "http://*", "https://*", "about:*", "data:*", "blob:*"]}
      allowingReadAccessToURL={page.directory}
      allowFileAccess
      incognito
      setSupportMultipleWindows={false}
      injectedJavaScriptBeforeContentLoaded={themeScript(pageTheme(theme, scheme))}
      onShouldStartLoadWithRequest={(load) => staysInPage(load, page)}
      onContentProcessDidTerminate={reload}
      onRenderProcessGone={reload}
      startInLoadingState
      renderLoading={() => <Loading />}
      style={[styles.flex, { backgroundColor: theme.background }]}
    />
  )
}

function WhiteboardView({ scene, title }: { scene: WhiteboardScene; title: string }) {
  const theme = useTheme()
  const scheme = useScheme()
  const drawing = drawWhiteboard(scene)
  if (drawing === null) return <EmptyState icon="Flow" title={copy("mobile_whiteboard_empty")} />
  return (
    <WebView
      testID="artifact-whiteboard"
      accessibilityLabel={title}
      source={{ html: whiteboardHtml(drawing, scheme) }}
      originWhitelist={["*"]}
      javaScriptEnabled={false}
      incognito
      style={[styles.flex, { backgroundColor: theme.background }]}
    />
  )
}

function ArtifactTitle({ title, version }: { title: string; version: number | null }) {
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
      <ActivityIndicator color={theme.textMuted} accessibilityLabel={copy("mobile_artifact_loading")} />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  banner: { paddingHorizontal: 16, paddingVertical: 8 },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    alignSelf: Platform.OS === "ios" ? "center" : "flex-start",
  },
  title: { flexShrink: 1, fontSize: 16, fontWeight: "600" },
  version: { fontSize: 13, fontVariant: ["tabular-nums"] },
})
