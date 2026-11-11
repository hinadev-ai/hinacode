import {
  type AnyExtension,
  getSchema,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
  Node,
} from "@tiptap/core"
import { Blockquote } from "@tiptap/extension-blockquote"
import { CodeBlock } from "@tiptap/extension-code-block"
import { Image } from "@tiptap/extension-image"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { TableKit } from "@tiptap/extension-table"
import { Markdown, MarkdownManager } from "@tiptap/markdown"
import { StarterKit } from "@tiptap/starter-kit"
import { Marked, type marked } from "marked"
import { calloutMarker, calloutTone, splitCalloutMarker } from "../documentCallout.ts"

export const isDocumentImagePath = (src: string) => /^images\/[^/]+$/.test(src)

const quoted = (markdown: string) =>
  markdown
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n")

const withoutFirstLine = (text: string) => text.slice(text.indexOf("\n") + 1)

const withoutLeadingSpace = (tokens: ReadonlyArray<MarkdownToken>) => {
  const start = tokens.findIndex((token) => token.type !== "space")
  return start === -1 ? [] : tokens.slice(start)
}

const calloutFromQuote = (quote: MarkdownToken, helpers: MarkdownParseHelpers) => {
  const [first, ...others] = quote.tokens ?? []
  const split = first?.type === "paragraph" ? splitCalloutMarker(first.text ?? "") : null
  if (first === undefined || split === null) return null
  const tokens =
    split.rest.trim() === ""
      ? withoutLeadingSpace(others)
      : [
          {
            ...first,
            raw: withoutFirstLine(first.raw ?? ""),
            text: split.rest,
            tokens: helpers.tokenizeInline?.(split.rest) ?? [],
          },
          ...others,
        ]
  const body = (helpers.parseBlockChildren ?? helpers.parseChildren)(tokens)
  return helpers.createNode(
    "callout",
    { tone: split.tone },
    body.length === 0 ? [helpers.createNode("paragraph")] : body,
  )
}

export const DocumentBlockquote = Blockquote.extend({
  parseMarkdown(token, helpers) {
    return calloutFromQuote(token, helpers) ?? this.parent?.(token, helpers) ?? []
  },
})

export const DocumentCallout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes: () => ({
    tone: {
      default: "note",
      parseHTML: (element) => calloutTone(element.getAttribute("data-tone")),
      renderHTML: (attributes) => ({ "data-tone": calloutTone(attributes["tone"]) }),
    },
  }),

  parseHTML: () => [{ tag: "div[data-callout]" }],

  renderHTML: ({ HTMLAttributes }) => ["div", { "data-callout": "", ...HTMLAttributes }, 0],

  renderMarkdown: (node, helpers) => {
    const children: ReadonlyArray<JSONContent> = node.content ?? []
    const body = children.map((child, index) =>
      quoted(helpers.renderChild?.(child, index) ?? helpers.renderChildren([child])),
    )
    return `> ${calloutMarker(calloutTone(node.attrs?.tone))}\n${body.join("\n>\n")}`
  },
})

export type DocumentNodeViews = {
  readonly callout?: AnyExtension
  readonly codeBlock?: AnyExtension
  readonly image?: AnyExtension
}

export const documentExtensions = (views: DocumentNodeViews = {}): AnyExtension[] => [
  StarterKit.configure({
    underline: false,
    link: { openOnClick: false },
    codeBlock: false,
    blockquote: false,
  }),
  DocumentBlockquote,
  views.codeBlock ?? CodeBlock,
  views.callout ?? DocumentCallout,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  views.image ?? Image,
]

// FIXME: @tiptap/markdown types `marked` as the global instance, but any Marked works, and a shared global stacks every manager's tokenizers (ueberdosis/tiptap#8316).
const ownMarked = () => new Marked() as unknown as typeof marked

export const documentMarkdown = () => Markdown.configure({ marked: ownMarked() })

export const createDocumentMarkdown = () => {
  const extensions = documentExtensions()
  return {
    schema: getSchema(extensions),
    markdown: new MarkdownManager({ marked: ownMarked(), extensions }),
  }
}
