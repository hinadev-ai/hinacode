import { gfm } from "@joplin/turndown-plugin-gfm"
import TurndownService from "turndown"

const GOOGLE_DOCS_WRAPPER = "b[id^='docs-internal-guid']"

const MARKDOWN_STRUCTURE = [
  "a[href]",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "pre",
  "code",
  "blockquote",
  "table",
  "strong",
  `b:not(${GOOGLE_DOCS_WRAPPER})`,
  "em",
  "i",
  "del",
  "s",
  "img",
  "hr",
].join(", ")

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
})
turndown.use(gfm)
turndown.addRule("listItem", {
  filter: "li",
  replacement: (content, node) => {
    const list = node.parentElement
    const start = Number(list?.getAttribute("start") ?? 1)
    const marker = list?.nodeName === "OL" ? `${start + [...list.children].indexOf(node)}. ` : "- "
    const paragraph = content.endsWith("\n")
    const body = content.replace(/^\n+|\n+$/g, "") + (paragraph ? "\n" : "")
    return marker + body.replaceAll("\n", `\n${" ".repeat(marker.length)}`) + (node.nextSibling ? "\n" : "")
  },
})
turndown.addRule("googleDocsWrapper", {
  filter: (node) => node.matches(GOOGLE_DOCS_WRAPPER),
  replacement: (content) => content,
})

const parsedHtml = (data: DataTransfer) => {
  const html = data.getData("text/html")
  return html === "" ? null : new DOMParser().parseFromString(html, "text/html").body
}

export const copiedFromProseMirror = (data: DataTransfer) => parsedHtml(data)?.querySelector("[data-pm-slice]") != null

export const hasMarkdownStructure = (data: DataTransfer) => parsedHtml(data)?.querySelector(MARKDOWN_STRUCTURE) != null

export const markdownOfClipboard = (data: DataTransfer) => {
  const body = parsedHtml(data)
  if (body?.querySelector(MARKDOWN_STRUCTURE) == null) return null
  return turndown.turndown(body)
}
