import { openURL } from "expo-linking"
import { router } from "expo-router"
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked"
import { type ReactNode, useMemo } from "react"
import { ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native"
import { CodeBlock } from "@/components/code-block"
import { Icon } from "@/components/icon"
import { MarkdownImage } from "@/components/markdown-image"
import { mono, type Palette, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { resolveFileLink } from "@/lib/markdown-paths"

interface Context {
  readonly theme: Palette
  readonly root: string | null
  readonly folder: string | undefined
  readonly threadId: string | undefined
}

const HEADING_SIZES = [22, 20, 18, 16, 15, 15]

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
}: {
  text: string
  root: string | null
  /** The folder a previewed file sits in, relative to `root`. Relative paths in a reply start at the root. */
  folder?: string
  threadId?: string
}) {
  const theme = useTheme()
  const tokens = useMemo(() => Lexer.lex(text, { gfm: true }), [text])
  return <View style={styles.blocks}>{blocks(tokens, { theme, root, folder, threadId })}</View>
}

function blocks(tokens: readonly Token[], context: Context): ReactNode[] {
  return tokens.map((token, index) => <Block key={index} token={token as MarkedToken} context={context} />)
}

function Block({ token, context }: { token: MarkedToken; context: Context }) {
  const { theme } = context
  switch (token.type) {
    case "heading": {
      const size = HEADING_SIZES[token.depth - 1] ?? 15
      return (
        <Paragraph
          tokens={token.tokens}
          context={context}
          style={{ fontSize: size, lineHeight: Math.round(size * 1.35), fontWeight: token.depth <= 2 ? "700" : "600" }}
          accessibilityRole="header"
        />
      )
    }
    case "paragraph":
      return <Paragraph tokens={token.tokens} context={context} />
    case "text":
      return token.tokens === undefined ? (
        <Text selectable style={[styles.paragraph, { color: theme.text }]}>
          {decodeEntities(token.text)}
        </Text>
      ) : (
        <Paragraph tokens={token.tokens} context={context} />
      )
    case "code":
      return <CodeBlock code={token.text} language={token.lang?.split(/\s/)[0] ?? ""} />
    case "blockquote":
      return (
        <View style={[styles.quote, { borderLeftColor: theme.border }]}>
          <View style={styles.blocks}>{blocks(token.tokens, context)}</View>
        </View>
      )
    case "list":
      return <List token={token} context={context} />
    case "table":
      return <Table token={token} context={context} />
    case "hr":
      return <View style={[styles.rule, { backgroundColor: theme.border }]} />
    case "html":
      return (
        <Text selectable style={[styles.paragraph, { color: theme.text }]}>
          {token.text.trimEnd()}
        </Text>
      )
    default:
      return null
  }
}

/** Inline text with the paragraph's images laid out as blocks below it, since React Native text cannot hold them. */
function Paragraph({
  tokens,
  context,
  style,
  accessibilityRole,
}: {
  tokens: readonly Token[]
  context: Context
  style?: TextStyle
  accessibilityRole?: "header"
}) {
  const images = collectImages(tokens)
  const textTokens = tokens.filter((token) => token.type !== "image" && token.type !== "checkbox")
  const hasText = textTokens.some((token) => token.type !== "br" && !(token.type === "text" && token.raw.trim() === ""))
  return (
    <>
      {hasText && (
        <Text
          selectable
          accessibilityRole={accessibilityRole}
          style={[styles.paragraph, { color: context.theme.text }, style]}
        >
          {inline(textTokens, context)}
        </Text>
      )}
      {images.map((image, index) => (
        <MarkdownImage key={index} src={image.href} alt={image.text} root={context.root} folder={context.folder} />
      ))}
    </>
  )
}

function collectImages(tokens: readonly Token[]): Tokens.Image[] {
  return tokens.flatMap((token) => {
    if (token.type === "image") return [token as Tokens.Image]
    return "tokens" in token && Array.isArray(token.tokens) ? collectImages(token.tokens) : []
  })
}

function inline(tokens: readonly Token[], context: Context): ReactNode[] {
  return tokens.map((token, index) => <Inline key={index} token={token as MarkedToken} context={context} />)
}

function Inline({ token, context }: { token: MarkedToken; context: Context }) {
  const { theme } = context
  switch (token.type) {
    case "text":
      return token.tokens !== undefined ? <>{inline(token.tokens, context)}</> : <>{decodeEntities(token.text)}</>
    case "escape":
    case "html":
      return <>{token.text}</>
    case "strong":
      return <Text style={styles.strong}>{inline(token.tokens, context)}</Text>
    case "em":
      return <Text style={styles.em}>{inline(token.tokens, context)}</Text>
    case "del":
      return <Text style={styles.del}>{inline(token.tokens, context)}</Text>
    case "codespan":
      return (
        <Text style={[styles.codespan, { backgroundColor: theme.surface }]}>{` ${token.text} `}</Text>
      )
    case "br":
      return <>{"\n"}</>
    case "link":
      return <Link token={token} context={context} />
    default:
      return null
  }
}

function Link({ token, context }: { token: Tokens.Link; context: Context }) {
  const { theme, root, folder, threadId } = context
  const label = inline(
    token.tokens.filter((child) => child.type !== "image"),
    context,
  )
  const href = token.href
  const filePath = threadId !== undefined ? resolveFileLink(href, root, folder) : null
  const onPress = /^(https?|mailto):/i.test(href)
    ? () => void openURL(href).catch(() => {})
    : filePath !== null && threadId !== undefined
      ? () => router.push({ pathname: "/thread/[id]/file", params: { id: threadId, path: filePath } })
      : undefined
  return (
    <Text
      accessibilityRole={onPress !== undefined ? "link" : undefined}
      onPress={onPress}
      style={[{ color: theme.link }, onPress !== undefined && styles.underline]}
    >
      {label}
    </Text>
  )
}

function List({ token, context }: { token: Tokens.List; context: Context }) {
  const { theme } = context
  const start = typeof token.start === "number" ? token.start : 1
  return (
    <View style={styles.list}>
      {token.items.map((item, index) => (
        <View key={index} style={styles.item}>
          <View style={styles.marker}>
            {item.task ? (
              <Icon
                name={item.checked === true ? "RiCheckboxLine" : "RiCheckboxBlankLine"}
                size={16}
                color={item.checked === true ? theme.primary : theme.textMuted}
              />
            ) : (
              <Text style={[styles.paragraph, { color: theme.textMuted }]}>
                {token.ordered ? `${start + index}.` : "•"}
              </Text>
            )}
          </View>
          <View style={[styles.blocks, styles.itemBody]}>
            {blocks(
              item.tokens.filter((child) => child.type !== "checkbox"),
              context,
            )}
          </View>
        </View>
      ))}
    </View>
  )
}

const columnWidth = (cells: readonly Tokens.TableCell[]) =>
  Math.min(280, Math.max(64, Math.max(...cells.map((cell) => cell.text.length)) * 8 + 20))

function Table({ token, context }: { token: Tokens.Table; context: Context }) {
  const { theme } = context
  const widths = token.header.map((_, column) =>
    columnWidth([token.header[column], ...token.rows.map((row) => row[column]).filter((cell) => cell !== undefined)]),
  )
  const row = (cells: readonly Tokens.TableCell[], header: boolean, index: number) => (
    <View
      key={index}
      style={[
        styles.row,
        { borderColor: theme.border },
        header && styles.headerRow,
        !header && index % 2 === 1 && { backgroundColor: theme.surface },
      ]}
    >
      {cells.map((cell, column) => (
        <View
          key={column}
          style={[styles.cell, { width: widths[column], borderColor: theme.border }, column === 0 && styles.firstCell]}
        >
          <Text
            selectable
            style={[
              styles.cellText,
              { color: theme.text, textAlign: token.align[column] ?? "left" },
              header && styles.strong,
            ]}
          >
            {inline(cell.tokens, context)}
          </Text>
        </View>
      ))}
    </View>
  )
  return (
    <ScrollView horizontal>
      <View style={[styles.table, { borderColor: theme.border }]}>
        {row(token.header, true, -1)}
        {token.rows.map((cells, index) => row(cells, false, index))}
      </View>
    </ScrollView>
  )
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" }

/** marked leaves named entities in text as written, and escapes a bare `&` next to a numeric one. */
const decodeEntities = (text: string) =>
  text.includes("&") ? text.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name: string) => ENTITIES[name]) : text

const styles = StyleSheet.create({
  blocks: { gap: 10 },
  paragraph: { fontSize: 15, lineHeight: 22 },
  strong: { fontWeight: "600" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  underline: { textDecorationLine: "underline" },
  codespan: { fontFamily: mono, fontSize: 14, borderRadius: radius.sm },
  quote: { borderLeftWidth: 3, paddingLeft: 12 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  list: { gap: 4 },
  item: { flexDirection: "row", gap: 6 },
  marker: { minWidth: 18, height: 22, alignItems: "flex-end", justifyContent: "center" },
  itemBody: { flex: 1 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: "hidden" },
  row: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  headerRow: { borderTopWidth: 0 },
  cell: { paddingHorizontal: 8, paddingVertical: 6, borderLeftWidth: StyleSheet.hairlineWidth },
  firstCell: { borderLeftWidth: 0 },
  cellText: { fontSize: 14, lineHeight: 20 },
})
