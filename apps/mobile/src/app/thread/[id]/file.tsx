import type { RpcResponse } from "@shared/contract.ts"
import type { FsFileContent, Thread } from "@shared/domain.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { FlatList, Image, Platform, ScrollView, StyleSheet, Text, View } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { SafeAreaView } from "react-native-safe-area-context"
import { SvgXml } from "react-native-svg"
import { Failure, Loading } from "@/components/files"
import { Markdown } from "@/components/markdown"
import { EmptyState, Notice, type Segment, SegmentedControl } from "@/components/ui"
import { cssEase } from "@/constants/motion"
import { mono, SyntaxColors } from "@/constants/theme"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { type CodeLine, codeLines } from "@/lib/code-lines"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { basename, dirname, fileKind, svgAspectRatio } from "@/lib/file-kinds"
import { useSyntaxSpans } from "@/lib/highlight"
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
        <EmptyState icon="RiQuestionLine" title={copy("mobile_files_thread_missing")} />
      ) : (
        <Loading label={copy("mobile_files_loading_thread")} />
      )}
    </SafeAreaView>
  )
}

function FileTitle({ path }: { path: string }) {
  const theme = useTheme()
  const folder = dirname(path)
  return (
    <View style={styles.title}>
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.titleName, { color: theme.text }]}>
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

type Loaded<T> = { readonly value: T } | { readonly error: string }

/** Reads `path` under `root` with `method`, again on `retry`. The result is null while loading. */
function useFile<M extends "fs.read" | "fs.preview">(method: M, root: string, path: string) {
  const key = `${method}\0${root}\0${path}`
  const [result, setResult] = useState<(Loaded<RpcResponse<M>> & { key: string }) | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    call(method, { root, path }).then(
      (value) => current && setResult({ key, value }),
      (cause) => current && setResult({ key, error: errorText(cause) }),
    )
    return () => {
      current = false
    }
  }, [key, method, root, path, revision])
  const retry = () => {
    setResult(null)
    setRevision(revision + 1)
  }
  return { result: result?.key === key ? result : null, retry }
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
    return <EmptyState icon="RiFileLine" title={copy("mobile_files_binary")} hint={copy("mobile_files_binary_hint")} />
  }
  if (result.value.content === "") return <EmptyState icon="RiFileTextLine" title={copy("mobile_files_empty_file")} />
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
        <CodeView content={file.content} line={line} truncated={file.truncated} />
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
              <Markdown text={file.content} root={root} folder={dirname(path)} threadId={threadId} />
            </ScrollView>
          ) : (
            <CodeView content={file.content} line={line} truncated={file.truncated} />
          )}
        </View>
      )}
    </WithText>
  )
}

/** Highlighting a whole megabyte would stall the phone, so only the start is colored. */
const HIGHLIGHT_LIMIT = 300_000
const LINE_HEIGHT = 18
const DIGIT_WIDTH = 7.4

function highlightable(content: string) {
  if (content.length <= HIGHLIGHT_LIMIT) return content
  const cut = content.lastIndexOf("\n", HIGHLIGHT_LIMIT)
  return content.slice(0, cut === -1 ? HIGHLIGHT_LIMIT : cut)
}

function CodeView({ content, line, truncated }: { content: string; line: number | null; truncated: boolean }) {
  const theme = useTheme()
  const colors = SyntaxColors[useScheme()]
  const spans = useSyntaxSpans(highlightable(content))
  const lines = codeLines(content, spans)
  const target = line === null ? null : Math.min(line, lines.length) - 1
  const list = useRef<FlatList<CodeLine>>(null)
  const attempts = useRef(0)
  const gutterWidth = String(lines.length).length * DIGIT_WIDTH + 12

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
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        if (attempts.current >= 5) return
        attempts.current += 1
        list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })
        setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false }), 100)
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
  const theme = useTheme()
  const { result, retry } = useFile("fs.preview", root, path)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
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
      <Image
        source={{ uri: result.value.dataUrl }}
        accessibilityRole="image"
        accessibilityLabel={copy("mobile_files_image_label", { name: basename(path) })}
        resizeMode="contain"
        onLoad={(event) => {
          const { width, height } = event.nativeEvent.source
          if (width > 0 && height > 0) setSize({ width, height })
        }}
        style={[
          styles.image,
          { backgroundColor: theme.surface },
          size !== null && { aspectRatio: size.width / size.height, maxWidth: Math.max(size.width, 96) },
        ]}
      />
    </ScrollView>
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
              fallback={<EmptyState icon="RiImageLine" title={copy("mobile_files_svg_failed")} />}
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
  title: { maxWidth: 260, alignItems: Platform.OS === "ios" ? "center" : "flex-start" },
  titleName: { fontSize: 16, fontWeight: "600" },
  titleFolder: { fontSize: 12, fontFamily: mono },
  notice: { paddingHorizontal: 12, paddingVertical: 8 },
  segments: { margin: 12 },
  markdown: { padding: 16, gap: 12 },
  code: { paddingVertical: 8 },
  codeRow: { flexDirection: "row", alignItems: "flex-start", paddingRight: 12 },
  flash: { ...StyleSheet.absoluteFill, pointerEvents: "none" },
  gutter: {
    fontFamily: mono,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    textAlign: "right",
    paddingRight: 12,
    fontVariant: ["tabular-nums"],
  },
  codeText: { flex: 1, fontFamily: mono, fontSize: 12, lineHeight: LINE_HEIGHT },
  comment: { fontStyle: "italic" },
  media: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  image: { width: "100%", aspectRatio: 1 },
})
