import type { RpcResponse } from "@shared/contract.ts"
import type { FsFileContent, Thread } from "@shared/domain.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Stack, useLocalSearchParams } from "expo-router"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { FlatList, Image, Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { SafeAreaView } from "react-native-safe-area-context"
import { SvgXml } from "react-native-svg"
import { Failure, Loading } from "@/components/files"
import { Markdown } from "@/components/markdown"
import { EmptyState, Notice, type Segment, SegmentedControl } from "@/components/ui"
import { cssEase } from "@/constants/motion"
import { mono, READABLE_WIDTH, SyntaxColors } from "@/constants/theme"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { type CodeLine, codeLines } from "@/lib/code-lines"
import type { RpcError } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { basename, dirname, fileKind, svgAspectRatio } from "@/lib/file-kinds"
import { useHighlight } from "@/lib/highlight"
import { asLoaded, familyOf, rpcFamily } from "@/lib/remote"
import { useThreadRoot, useThreads } from "@/stores/threads"

type Params = { id: string; path: string; line?: string }

export default function FileScreen() {
  const theme = useTheme()
  const { id, path, line } = useLocalSearchParams<Params>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  const target = line === undefined ? null : Number.parseInt(line, 10)
  return (
    <SafeAreaView edges={["bottom"]} style={[styles.flex, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: basename(path), headerTitle: () => <FileTitle path={path} /> }} />
      {thread !== undefined ? (
        <FileBody
          thread={thread}
          path={path}
          line={target !== null && Number.isFinite(target) && target > 0 ? target : null}
        />
      ) : loaded ? (
        <EmptyState icon="Question" title={copy("mobile_files_thread_missing")} />
      ) : (
        <Loading label={copy("mobile_files_loading_thread")} />
      )}
    </SafeAreaView>
  )
}

function FileTitle({ path }: { path: string }) {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  const folder = dirname(path)
  return (
    <View style={[styles.title, { maxWidth: width - TITLE_INSET }]}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        ellipsizeMode="middle"
        style={[styles.titleName, { color: theme.text }]}
      >
        {basename(path)}
      </Text>
      {folder !== "" && (
        <Text numberOfLines={1} ellipsizeMode="head" style={[styles.titleFolder, { color: theme.textMuted }]}>
          {folder}
        </Text>
      )}
    </View>
  )
}

function FileBody({ thread, path, line }: { thread: Thread; path: string; line: number | null }) {
  const root = useThreadRoot(thread)
  if (root === null) return <Loading label={copy("mobile_files_finding_workspace")} />
  switch (fileKind(path)) {
    case "image":
      return <ImageFile root={root} path={path} />
    case "svg":
      return <SvgFile root={root} path={path} />
    case "markdown":
      return <MarkdownFile root={root} path={path} line={line} threadId={thread.id} />
    case "text":
      return <TextFile root={root} path={path} line={line} />
  }
}

const fileReads = { "fs.read": rpcFamily("fs.read"), "fs.preview": rpcFamily("fs.preview") }

/** Reads `path` under `root` with `method`, again on `retry`. The result is null while loading. */
function useFile<M extends keyof typeof fileReads>(method: M, root: string, path: string) {
  const file = fileReads[method]({ root, path }) as Atom.Atom<AsyncResult.AsyncResult<RpcResponse<M>, RpcError>>
  return { result: asLoaded(useAtomValue(file)), retry: useAtomRefresh(file) }
}

const useFileText = (root: string, path: string) => useFile("fs.read", root, path)

/** Loading, error and binary states around a file's text. */
function WithText({
  root,
  path,
  children,
}: {
  root: string
  path: string
  children: (file: FsFileContent) => ReactNode
}) {
  const { result, retry } = useFileText(root, path)
  if (result === null) return <Loading label={copy("mobile_files_loading_file")} />
  if ("error" in result) return <Failure message={result.error} onRetry={retry} />
  if (result.value.binary) {
    return <EmptyState icon="File" title={copy("mobile_files_binary")} hint={copy("mobile_files_binary_hint")} />
  }
  if (result.value.content === "") return <EmptyState icon="FileText" title={copy("mobile_files_empty_file")} />
  return children(result.value)
}

const TruncatedNotice = ({ truncated }: { truncated: boolean }) =>
  truncated ? (
    <View style={styles.notice}>
      <Notice text={copy("mobile_files_truncated")} tone="attention" />
    </View>
  ) : null

function TextFile({ root, path, line }: { root: string; path: string; line: number | null }) {
  return (
    <WithText root={root} path={path}>
      {(file) => (
        <CodeView path={path} content={file.content} line={line} truncated={file.truncated} />
      )}
    </WithText>
  )
}

type MarkdownView = "preview" | "source"

const markdownViews: readonly Segment<MarkdownView>[] = [
  { value: "preview", label: copy("mobile_files_preview") },
  { value: "source", label: copy("mobile_files_source") },
]

function MarkdownFile({
  root,
  path,
  line,
  threadId,
}: {
  root: string
  path: string
  line: number | null
  threadId: string
}) {
  const [view, setView] = useState<MarkdownView>(line === null ? "preview" : "source")
  return (
    <WithText root={root} path={path}>
      {(file) => (
        <View style={styles.flex}>
          <SegmentedControl
            accessibilityLabel={copy("mobile_files_view_label")}
            segments={markdownViews}
            value={view}
            onChange={setView}
            style={styles.segments}
          />
          {view === "preview" ? (
            <ScrollView contentContainerStyle={styles.markdown}>
              <TruncatedNotice truncated={file.truncated} />
              <Markdown text={file.content} root={root} folder={dirname(path)} threadId={threadId} gutter={PAGE_PADDING} />
            </ScrollView>
          ) : (
            <CodeView path={path} content={file.content} line={line} truncated={file.truncated} />
          )}
        </View>
      )}
    </WithText>
  )
}

/** Highlighting a whole megabyte would stall the phone, so only the start is colored. */
const HIGHLIGHT_LIMIT = 300_000
const PAGE_PADDING = 16
const LINE_HEIGHT = 18
const DIGIT_WIDTH = 7.4
const TITLE_INSET = 120
const JUMP_STEPS = 80

function highlightable(content: string) {
  if (content.length <= HIGHLIGHT_LIMIT) return content
  const cut = content.lastIndexOf("\n", HIGHLIGHT_LIMIT)
  return content.slice(0, cut === -1 ? HIGHLIGHT_LIMIT : cut)
}

function CodeView({
  path,
  content,
  line,
  truncated,
}: {
  path: string
  content: string
  line: number | null
  truncated: boolean
}) {
  const theme = useTheme()
  const colors = SyntaxColors[useScheme()]
  const { spans } = useHighlight(path, highlightable(content))
  const lines = codeLines(content, spans)
  const target = line === null ? null : Math.min(line, lines.length) - 1
  const list = useRef<FlatList<CodeLine>>(null)
  const attempts = useRef(0)
  const gutterWidth = Math.ceil(String(lines.length).length * DIGIT_WIDTH) + 12

  useEffect(() => {
    if (target === null) return
    const frame = requestAnimationFrame(() =>
      list.current?.scrollToIndex({ index: target, viewPosition: 0.3, animated: false }),
    )
    return () => cancelAnimationFrame(frame)
  }, [target])

  return (
    <FlatList
      ref={list}
      data={lines}
      keyExtractor={(_, index) => String(index)}
      ListHeaderComponent={<TruncatedNotice truncated={truncated} />}
      initialNumToRender={60}
      maxToRenderPerBatch={60}
      windowSize={15}
      contentContainerStyle={styles.code}
      onScrollToIndexFailed={({ index, highestMeasuredFrameIndex }) => {
        if (attempts.current >= JUMP_STEPS) return
        attempts.current += 1
        list.current?.scrollToIndex({ index: highestMeasuredFrameIndex, animated: false })
        setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false }), 50)
      }}
      renderItem={({ item, index }) => (
        <View style={styles.codeRow}>
          {index === target && <LineFlash />}
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={[styles.gutter, { width: gutterWidth, color: theme.textMuted }]}
          >
            {index + 1}
          </Text>
          <Text selectable style={[styles.codeText, { color: colors.plain }]}>
            {item.length === 0
              ? " "
              : item.map((span, key) => (
                  <Text key={key} style={[{ color: colors[span.type] }, span.type === "comment" && styles.comment]}>
                    {span.text.replace(/\t/g, "  ")}
                  </Text>
                ))}
          </Text>
        </View>
      )}
    />
  )
}

const fadeOut = { from: { opacity: 1 }, to: { opacity: 0 } }

/** Tints the line a search hit opened at, then fades. Under reduce motion the tint stays briefly and goes. */
function LineFlash() {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!reduced) return
    const timer = setTimeout(() => setVisible(false), 2000)
    return () => clearTimeout(timer)
  }, [reduced])
  if (!visible) return null
  return (
    <Animated.View
      style={[
        styles.flash,
        { backgroundColor: theme.attentionBg },
        !reduced && {
          animationName: fadeOut,
          animationDuration: 1500,
          animationDelay: 500,
          animationFillMode: "forwards",
          animationTimingFunction: cssEase.out,
        },
      ]}
    />
  )
}

function ImageFile({ root, path }: { root: string; path: string }) {
  const { result, retry } = useFile("fs.preview", root, path)
  if (result === null) return <Loading label={copy("mobile_files_loading_file")} />
  if ("error" in result) return <Failure message={result.error} onRetry={retry} />
  return (
    <ScrollView
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      contentContainerStyle={styles.media}
      style={styles.flex}
    >
      <FittedImage uri={result.value.dataUrl} label={copy("mobile_files_image_label", { name: basename(path) })} />
    </ScrollView>
  )
}

// FIXME: `onLoad` reports no size on react-native-web, so the image is measured on its own.
const imageSize = familyOf((uri: string) =>
  Atom.make(
    Effect.callback<{ width: number; height: number } | null>((resume) =>
      Image.getSize(
        uri,
        (width, height) => resume(Effect.succeed(width > 0 && height > 0 ? { width, height } : null)),
        () => resume(Effect.succeed(null)),
      ),
    ),
  ),
)

/** As wide as the screen, or its natural width when narrower, keeping its aspect ratio. */
function FittedImage({ uri, label }: { uri: string; label: string }) {
  const theme = useTheme()
  const size = AsyncResult.getOrElse(useAtomValue(imageSize(uri)), () => null)
  return (
    <Image
      source={{ uri }}
      accessibilityRole="image"
      accessibilityLabel={label}
      resizeMode="contain"
      style={[
        styles.image,
        { backgroundColor: theme.surface },
        size !== null && { aspectRatio: size.width / size.height, maxWidth: Math.max(size.width, 96) },
      ]}
    />
  )
}

function SvgFile({ root, path }: { root: string; path: string }) {
  const theme = useTheme()
  return (
    <WithText root={root} path={path}>
      {(file) => (
        <ScrollView maximumZoomScale={4} minimumZoomScale={1} contentContainerStyle={styles.media} style={styles.flex}>
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={copy("mobile_files_image_label", { name: basename(path) })}
            style={[styles.image, { aspectRatio: svgAspectRatio(file.content) ?? 1, backgroundColor: theme.surface }]}
          >
            <SvgXml
              xml={file.content}
              width="100%"
              height="100%"
              onError={() => undefined}
              fallback={<EmptyState icon="Image" title={copy("mobile_files_svg_failed")} />}
            />
          </View>
        </ScrollView>
      )}
    </WithText>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // iOS centers the title, Android puts it after the back button.
  title: { alignItems: Platform.OS === "ios" ? "center" : "flex-start" },
  titleName: { fontSize: 16, fontWeight: "600" },
  titleFolder: { fontSize: 12, fontFamily: mono },
  notice: { paddingHorizontal: 12, paddingVertical: 8 },
  segments: { margin: 12 },
  markdown: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center", padding: PAGE_PADDING, gap: 12 },
  code: { paddingVertical: 8 },
  codeRow: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 12 },
  flash: { ...StyleSheet.absoluteFill, pointerEvents: "none" },
  gutter: {
    fontFamily: mono,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    textAlign: "right",
    paddingRight: 12,
    fontVariant: ["tabular-nums"],
  },
  // A browser keeps a flex item as wide as its longest token unless it may shrink, so a long one ran off screen.
  codeText: { flex: 1, minWidth: 0, fontFamily: mono, fontSize: 12, lineHeight: LINE_HEIGHT },
  comment: { fontStyle: "italic" },
  media: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  image: { width: "100%", aspectRatio: 1 },
})
