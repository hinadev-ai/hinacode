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

const INLINE_FORMAT = ["strong", `b:not(${GOOGLE_DOCS_WRAPPER})`, "em", "i", "del", "s", ":not(pre) > code"].join(", ")

const paragraph = (content: string) => `\n\n${content}\n\n`

const withoutEdgeBreaks = (content: string) => content.replace(/^\n+|\n+$/g, "")

const inlineFormats = new TurndownService({ emDelimiter: "*" })
inlineFormats.escape = (text) => text
inlineFormats
  .addRule("strikethrough", { filter: ["del", "s"], replacement: (content) => `~~${content}~~` })
  .addRule("lineBreak", {
    filter: "br",
    replacement: (_, node) => (node.previousSibling?.nodeName === "BR" ? "\n\n" : "\n"),
  })
  .addRule("plainBlock", { filter: ["h1", "h2", "h3", "h4", "h5", "h6", "blockquote"], replacement: paragraph })
  .addRule("plainCode", { filter: "pre", replacement: (_, node) => paragraph(node.textContent ?? "") })
  .addRule("plainList", { filter: ["ul", "ol"], replacement: (content) => `\n${content}\n` })
  .addRule("plainListItem", { filter: "li", replacement: (content) => `${withoutEdgeBreaks(content)}\n` })
  .addRule("plainRow", { filter: "tr", replacement: (content) => `${content}\n` })
  .addRule("plainCell", {
    filter: ["th", "td"],
    replacement: (content, node) => withoutEdgeBreaks(content) + (node.nextSibling ? "\t" : ""),
  })
  .addRule("unwrapped", {
    filter: (node) => node.nodeName === "A" || node.matches(GOOGLE_DOCS_WRAPPER),
    replacement: (content) => content,
  })
  .addRule("dropped", { filter: ["img", "hr"], replacement: () => "" })

const parsedHtml = (data: DataTransfer) => {
  const html = data.getData("text/html")
  return html === "" ? null : new DOMParser().parseFromString(html, "text/html").body
}

export const copiedFromProseMirror = (data: DataTransfer) => parsedHtml(data)?.querySelector("[data-pm-slice]") != null

export const hasMarkdownStructure = (data: DataTransfer) => parsedHtml(data)?.querySelector(MARKDOWN_STRUCTURE) != null

export const inlineFormatsOfClipboard = (data: DataTransfer) => {
  const body = parsedHtml(data)
  if (body?.querySelector(INLINE_FORMAT) == null) return null
  return inlineFormats.turndown(body)
}
