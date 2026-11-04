import { router } from "expo-router"
import { useState } from "react"
import { Image, Modal, Platform, Pressable, StyleSheet, type ViewStyle } from "react-native"
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown"
import { Colors, mono, type Palette, radius, SyntaxColors } from "@/constants/theme"
import { type Scheme, useScheme } from "@/hooks/use-theme"
import { useWorkspaceImages } from "@/hooks/use-workspace-images"
import { copy } from "@/lib/copy"
import { rewriteMarkdownExtras } from "@/lib/markdown-extras"
import { resolveFileLink } from "@/lib/markdown-paths"
import { openWebUrl } from "@/lib/open-url"
import "./markdown.css"

const HEADING_SIZES = [22, 20, 18, 16, 15, 15] as const
const BLOCK_GAP = 10

/** A document is read rather than skimmed: larger text with more room, and space above each section. */
const MEASURES = {
  reply: { text: 15, line: 22, gap: BLOCK_GAP, headings: HEADING_SIZES, headingGaps: [0, 0, 0, 0, 0, 0] },
  document: { text: 16, line: 25, gap: 14, headings: [26, 21, 18, 16, 16, 16], headingGaps: [0, 18, 14, 10, 10, 10] },
} as const

export type MarkdownMeasure = keyof typeof MEASURES

function markdownStyle(
  theme: Palette,
  syntax: (typeof SyntaxColors)[Scheme],
  gutter: number,
  measure: MarkdownMeasure,
): MarkdownStyle {
  const { text, line, gap, headings, headingGaps } = MEASURES[measure]
  const heading = (depth: number) => {
    const size = headings[depth - 1]
    return {
      fontSize: size,
      lineHeight: Math.round(size * 1.35),
      fontWeight: depth <= 2 ? "700" : "600",
      color: theme.text,
      marginTop: headingGaps[depth - 1],
      marginBottom: measure === "document" && depth <= 2 ? gap - 4 : BLOCK_GAP,
    }
  }
  return {
    paragraph: { fontSize: text, lineHeight: line, color: theme.text, marginTop: 0, marginBottom: gap },
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    strong: { color: theme.text },
    strikethrough: { color: theme.textMuted },
    link: { color: theme.link, underline: true },
    code: { fontFamily: mono, fontSize: 14, color: theme.text, backgroundColor: theme.surface, borderColor: theme.border },
    codeBlock: {
      fontFamily: mono,
      fontSize: 13,
      lineHeight: 19,
      color: syntax.plain,
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.md,
      padding: 12,
      marginBottom: gap,
      syntaxColors: {
        keyword: syntax.keyword,
        operator: syntax.operator,
        string: syntax.string,
        number: syntax.number,
        constant: syntax.constant,
        comment: syntax.comment,
        function: syntax.function,
        type: syntax.type,
      },
    },
    blockquote: {
      color: theme.text,
      backgroundColor: "transparent",
      borderColor: theme.border,
      borderWidth: 3,
      gapWidth: 12,
      marginBottom: gap,
    },
    list: {
      fontSize: text,
      lineHeight: line,
      color: theme.text,
      bulletColor: theme.textMuted,
      markerColor: theme.textMuted,
      itemSpacing: 4,
      marginBottom: gap,
    },
    table: {
      fontSize: 14,
      lineHeight: 20,
      color: theme.text,
      headerTextColor: theme.text,
      headerBackgroundColor: theme.background,
      rowEvenBackgroundColor: theme.background,
      rowOddBackgroundColor: theme.surface,
      borderColor: theme.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.sm,
      horizontalOverflow: gutter,
      marginBottom: gap,
    },
    taskList: {
      checkedColor: theme.primary,
      borderColor: theme.textMuted,
      checkmarkColor: theme.onPrimary,
      checkedTextColor: theme.textMuted,
    },
    thematicBreak: { color: theme.border, height: StyleSheet.hairlineWidth, marginTop: 4, marginBottom: gap + 4 },
    // A fixed box: on Android 1.1.1 a `maxHeight` box draws taller than the layout reserves, cutting off the reply's end.
    image: { borderRadius: radius.md, height: 240, resizeMode: "contain", marginBottom: gap },
  }
}

// One object per scheme, gutter and measure, so the native view does not receive a new style on every render.
const STYLES = new Map<string, MarkdownStyle>()

function stylesFor(scheme: Scheme, gutter: number, measure: MarkdownMeasure) {
  const key = `${scheme}:${gutter}:${measure}`
  const cached = STYLES.get(key)
  if (cached !== undefined) return cached
  const style = markdownStyle(Colors[scheme], SyntaxColors[scheme], gutter, measure)
  STYLES.set(key, style)
  return style
}

// The web renderer's root is a div that takes CSS as is. Native text views already break a word too long for a line.
const CONTAINER = Platform.OS === "web" ? ({ overflowWrap: "break-word" } as ViewStyle) : undefined

// Agents write shell variables in prose, and two `$` on one line would otherwise render as math.
const FLAGS = { latexMath: false }

/**
 * Renders an agent's Markdown. `root` is the thread's working folder, which relative image paths and file links
 * resolve against; null when it is not known, such as for a pull request body. File links open the file viewer
 * only when `threadId` is given.
 */
export function Markdown({
  text,
  root,
  folder,
  threadId,
  gutter = 0,
  measure = "reply",
}: {
  text: string
  root: string | null
  /** The folder a previewed file sits in, relative to `root`. Relative paths in a reply start at the root. */
  folder?: string
  threadId?: string
  /**
   * The parent's horizontal padding. A table too wide to fit scrolls out to the screen edge through it, so its cut
   * column reads as scrollable. Leave it 0 inside a card.
   */
  gutter?: number
  measure?: MarkdownMeasure
}) {
  const scheme = useScheme()
  const markdown = useWorkspaceImages(text, root, folder)
  const [openImage, setOpenImage] = useState<string | null>(null)

  const onLinkPress = ({ url }: { url: string }) => {
    if (/^https?:/i.test(url)) return openWebUrl(url)
    if (threadId === undefined) return
    const path = resolveFileLink(url, root, folder)
    if (path !== null) router.push({ pathname: "/thread/[id]/file", params: { id: threadId, path } })
  }

  return (
    <>
      <EnrichedMarkdownText
        markdown={rewriteMarkdownExtras(markdown)}
        flavor="github"
        markdownStyle={stylesFor(scheme, gutter, measure)}
        md4cFlags={FLAGS}
        containerStyle={CONTAINER}
        enableTaskListItemToggle={false}
        onLinkPress={onLinkPress}
        onImagePress={({ url }) => setOpenImage(url)}
      />
      <Modal
        visible={openImage !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setOpenImage(null)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_image_close")}
          onPress={() => setOpenImage(null)}
          style={styles.backdrop}
        >
          {openImage !== null && (
            <Image
              source={{ uri: openImage }}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
              style={styles.fill}
            />
          )}
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.92)", padding: 16 },
  fill: { width: "100%", height: "100%" },
})
