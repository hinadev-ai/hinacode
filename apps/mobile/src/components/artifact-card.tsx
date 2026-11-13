import { outputText, publishedArtifact, publishedKind } from "@shared/agent.ts"
import { publishPreview } from "@shared/compactTranscript.ts"
import type { MessagePart } from "@shared/domain.ts"
import { type DocumentOutline, type OutlineBlock, outlineSections } from "@shared/documentOutline.ts"
import {
  linePath,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  type ThumbnailInk,
  type ThumbnailMark,
  thumbnailMarks,
} from "@shared/documentThumbnail.ts"
import { router } from "expo-router"
import { StyleSheet, Text, View } from "react-native"
import Svg, { Circle, Path, Rect } from "react-native-svg"
import { Icon } from "@/components/icon"
import { FadeIn, PressableScale, Pulse } from "@/components/motion"
import { CalloutColors, radius } from "@/constants/theme"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const summaryOf = (outline: DocumentOutline | null) => {
  if (outline === null) return null
  if (outline.lede !== null) return outline.lede
  const { shown, more } = outlineSections(outline.blocks)
  if (shown.length === 0) return null
  const listed = shown.join(copy("mobile_artifact_sections_separator"))
  return more > 0 ? copy("mobile_artifact_card_more_sections", { sections: listed, count: String(more) }) : listed
}

const cardCopy = {
  page: { kind: "mobile_artifact_card_page", untitled: "mobile_artifact_untitled_page" },
  document: { kind: "mobile_artifact_card_document", untitled: "mobile_artifact_untitled_document" },
  whiteboard: { kind: "mobile_artifacts_whiteboard", untitled: "mobile_artifact_untitled_whiteboard" },
} as const

const openDocument = (threadId: string, artifactId: string, title: string) =>
  router.push({ pathname: "/thread/[id]/document", params: { id: threadId, artifactId, title } })

export function ArtifactCard({ part, threadId }: { part: ToolCall; threadId: string }) {
  const theme = useTheme()
  const artifactKind = publishedKind(part.name) ?? "page"
  const isDocument = artifactKind === "document"
  const preview = publishPreview(part.input)
  const published = part.output === undefined ? null : publishedArtifact(outputText(part.output))
  const title = preview.title ?? preview.outline?.title ?? copy(cardCopy[artifactKind].untitled)
  const summary = summaryOf(preview.outline)
  const kind = copy(cardCopy[artifactKind].kind)
  const publishing = part.status === "running"
  const openable = isDocument && published !== null

  const content = (
    <>
      <Thumbnail blocks={isDocument ? (preview.outline?.blocks ?? []) : null} />
      <View style={styles.text}>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: theme.textMuted }]}>{kind}</Text>
          {publishing ? (
            <Pulse text={`· ${copy("mobile_artifact_card_publishing")}`} style={styles.metaText} />
          ) : (
            published !== null && (
              <Text style={[styles.metaText, styles.version, { color: theme.textMuted }]}>
                {`· ${copy("mobile_artifact_card_version", { version: String(published.version) })}`}
              </Text>
            )
          )}
        </View>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {title}
        </Text>
        {summary !== null && (
          <Text numberOfLines={2} style={[styles.summary, { color: theme.textMuted }]}>
            {summary}
          </Text>
        )}
      </View>
      {openable && <Icon name="ChevronRight" size={16} color={theme.textMuted} />}
    </>
  )

  return (
    <FadeIn enabled={publishing}>
      {openable ? (
        <PressableScale
          testID="artifact-card"
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_artifact_open", { title })}
          accessibilityHint={summary ?? undefined}
          onPress={() => openDocument(threadId, published.id, title)}
          style={[styles.card, { backgroundColor: theme.surface }]}
        >
          {content}
        </PressableScale>
      ) : (
        <View
          testID="artifact-card"
          accessible
          accessibilityLabel={`${kind}, ${title}`}
          style={[styles.card, { backgroundColor: theme.surface }]}
        >
          {content}
        </View>
      )}
    </FadeIn>
  )
}

function Thumbnail({ blocks }: { blocks: readonly OutlineBlock[] | null }) {
  const theme = useTheme()
  const scheme = useScheme()
  const tones = CalloutColors[scheme]
  const inks: Record<ThumbnailInk, string> = {
    ink: theme.text,
    chart: tones.note.ink,
    note: tones.note.ink,
    tip: tones.tip.ink,
    important: tones.important.ink,
    warning: tones.warning.ink,
    caution: tones.caution.ink,
  }
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.page, { backgroundColor: scheme === "dark" ? theme.surfaceStrong : theme.background }]}
    >
      <Svg width={THUMBNAIL_WIDTH} height={THUMBNAIL_HEIGHT} viewBox={`0 0 ${THUMBNAIL_WIDTH} ${THUMBNAIL_HEIGHT}`}>
        {thumbnailMarks(blocks).map((mark, index) => (
          <Mark key={index} mark={mark} color={inks[mark.ink]} />
        ))}
      </Svg>
    </View>
  )
}

function Mark({ mark, color }: { mark: ThumbnailMark; color: string }) {
  switch (mark.kind) {
    case "rect":
      return (
        <Rect
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          rx={mark.radius}
          fill={color}
          fillOpacity={mark.opacity}
        />
      )
    case "outline":
      return (
        <Rect
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          rx={mark.radius}
          fill="none"
          stroke={color}
          strokeOpacity={mark.opacity}
          strokeWidth={mark.strokeWidth}
        />
      )
    case "dot":
      return <Circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={color} fillOpacity={mark.opacity} />
    case "line":
      return (
        <Path
          d={linePath(mark)}
          fill="none"
          stroke={color}
          strokeOpacity={mark.opacity}
          strokeWidth={mark.strokeWidth}
        />
      )
  }
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: radius.lg,
    padding: 10,
    paddingEnd: 14,
    marginVertical: 2,
  },
  page: { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, borderRadius: radius.sm, overflow: "hidden" },
  text: { flex: 1, minWidth: 0, gap: 2 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 12, lineHeight: 16 },
  version: { fontVariant: ["tabular-nums"] },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  summary: { fontSize: 13, lineHeight: 18 },
})
