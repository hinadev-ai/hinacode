import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"

interface MdastNode {
  type: string
  value?: string
  children?: Array<MdastNode>
}

interface HastNode {
  type: string
  children?: Array<HastNode>
}

const formControls = new Set(["button", "fieldset", "form", "input", "label", "option", "select", "textarea"])

const renderableTags = new Set((defaultSchema.tagNames ?? []).filter((tag) => !formControls.has(tag)))

const flowParents = new Set(["root", "blockquote", "listItem", "footnoteDefinition"])

const tagOf = (html: string) => /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(html.trimStart())?.[1]?.toLowerCase()

const guardChildren = (node: MdastNode) => {
  if (!node.children) return
  const flow = flowParents.has(node.type)
  node.children = node.children.flatMap((child): Array<MdastNode> => {
    if (child.type !== "html") {
      guardChildren(child)
      return [child]
    }
    const value = child.value ?? ""
    if (value.trimStart().startsWith("<!--")) return []
    const tag = tagOf(value)
    if (tag !== undefined && renderableTags.has(tag)) return [child]
    const text = { type: "text", value }
    return [flow ? { type: "paragraph", children: [text] } : text]
  })
}

export const remarkUnknownTagsAsText = () => (tree: MdastNode) => guardChildren(tree)

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.["img"] ?? []), "srcSet", "sizes"],
    source: [...(defaultSchema.attributes?.["source"] ?? []), "sizes"],
  },
}

type HastTransform = (tree: HastNode, file?: unknown) => HastNode

const parseRaw = rehypeRaw() as unknown as HastTransform
const sanitize = rehypeSanitize(schema) as unknown as HastTransform

const hasRawNode = (root: HastNode) => {
  const stack: Array<HastNode> = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "raw") return true
    if (node.children) stack.push(...node.children)
  }
  return false
}

export const rehypeEmbeddedHtml = () => (tree: HastNode, file?: unknown) =>
  hasRawNode(tree) ? sanitize(parseRaw(tree, file), file) : tree

export interface ServiceBadge {
  readonly href: string
  readonly alt: string
  readonly src: string
  readonly darkSrc: string | null
  readonly lightSrc: string | null
  readonly width: number | null
  readonly height: number | null
}

export type MarkdownSegment =
  | { readonly type: "markdown"; readonly text: string }
  | { readonly type: "badges"; readonly badges: ReadonlyArray<ServiceBadge>; readonly note: string | null }

interface ServiceBlockDelimiters {
  readonly open: RegExp
  readonly close: RegExp
}

const badgeBlocks: ReadonlyArray<ServiceBlockDelimiters> = [
  { open: /<!--\s*codesmith:footer\s*-->/, close: /<!--\s*\/codesmith:footer\s*-->/ },
]

const attributeOf = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1] ?? null

const firstUrlOf = (srcset: string) => srcset.trim().split(/\s+/)[0] ?? ""

const numberOf = (value: string | null) => {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()

const badgeOf = (anchorTag: string, inner: string): ServiceBadge | null => {
  const img = /<img\b[^>]*>/i.exec(inner)?.[0]
  const href = attributeOf(anchorTag, "href")
  if (href === null || img === undefined) return null
  const src = attributeOf(img, "src")
  if (src === null) return null
  let darkSrc: string | null = null
  let lightSrc: string | null = null
  for (const source of inner.match(/<source\b[^>]*>/gi) ?? []) {
    const srcset = attributeOf(source, "srcset")
    if (srcset === null) continue
    const scheme = /prefers-color-scheme:\s*(dark|light)/i.exec(attributeOf(source, "media") ?? "")?.[1]?.toLowerCase()
    if (scheme === "dark") darkSrc = firstUrlOf(srcset)
    if (scheme === "light") lightSrc = firstUrlOf(srcset)
  }
  return {
    href,
    alt: attributeOf(img, "alt") ?? "",
    src,
    darkSrc,
    lightSrc,
    width: numberOf(attributeOf(img, "width")),
    height: numberOf(attributeOf(img, "height")),
  }
}

export const parseBadgeBlock = (block: string): { badges: Array<ServiceBadge>; note: string | null } | null => {
  const badges: Array<ServiceBadge> = []
  for (const match of block.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) {
    const badge = badgeOf(match[1] ?? "", match[2] ?? "")
    if (badge !== null) badges.push(badge)
  }
  if (badges.length === 0) return null
  const noted = /<sup\b[^>]*>([\s\S]*?)<\/sup>/i.exec(block)?.[1]
  return { badges, note: noted === undefined ? null : textOf(noted) }
}

const findBadgeBlock = (text: string) => {
  for (const delimiters of badgeBlocks) {
    const open = delimiters.open.exec(text)
    if (open === null) continue
    const rest = text.slice(open.index + open[0].length)
    const close = delimiters.close.exec(rest)
    if (close === null) continue
    const parsed = parseBadgeBlock(rest.slice(0, close.index))
    if (parsed === null) continue
    return { parsed, start: open.index, end: open.index + open[0].length + close.index + close[0].length }
  }
  return null
}

export const segmentServiceBlocks = (text: string): ReadonlyArray<MarkdownSegment> => {
  if (!text.includes("<!--")) return [{ type: "markdown", text }]
  const segments: Array<MarkdownSegment> = []
  let rest = text
  for (let found = findBadgeBlock(rest); found !== null; found = findBadgeBlock(rest)) {
    const before = rest.slice(0, found.start)
    if (before.trim() !== "") segments.push({ type: "markdown", text: before })
    segments.push({ type: "badges", badges: found.parsed.badges, note: found.parsed.note })
    rest = rest.slice(found.end)
  }
  if (segments.length === 0) return [{ type: "markdown", text }]
  if (rest.trim() !== "") segments.push({ type: "markdown", text: rest })
  return segments
}
