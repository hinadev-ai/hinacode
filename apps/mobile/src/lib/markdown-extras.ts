const FENCE = /^ {0,3}(`{3,}|~{3,})/
const BARE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/m
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/g
const KBD = /<kbd>(.*?)<\/kbd>/gi
const CODE_SPAN = /(`+)[^`]+?\1(?!`)/g
const LINK_OR_AUTOLINK = /!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>/g
const URL_BEFORE_PUNCTUATION = /(?<![\w/"'=(<[])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?])([.,;:!?]+)(?=\s|$)/gi
const PULL_REQUEST_URL = /(?<![\w/"'=])https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?![\w/?#=&-])/gi
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹"

const superscript = (value: number) =>
  String(value)
    .split("")
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)])
    .join("")

const codeSpan = (text: string) => (text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``)

const keysAsCode = (prose: string) => prose.replace(KBD, (_, key: string) => codeSpan(key))

function outside(protect: RegExp, text: string, rewrite: (rest: string) => string) {
  let result = ""
  let last = 0
  for (const match of text.matchAll(protect)) {
    result += rewrite(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return result + rewrite(text.slice(last))
}

const outsideCode = (line: string, rewrite: (prose: string) => string) => outside(CODE_SPAN, line, rewrite)

const rewriteBareUrls = (prose: string) =>
  outside(LINK_OR_AUTOLINK, prose, (text) =>
    text
      .replace(
        PULL_REQUEST_URL,
        (url, owner: string, name: string, number: string) => `[${owner}/${name}#${number}](${url})`,
      )
      .replace(URL_BEFORE_PUNCTUATION, "<$1>$2"),
  )

function mapProseLines(
  markdown: string,
  visit: (line: string) => string | null,
  open: (line: string) => string = (line) => line,
) {
  let fence: string | null = null
  const lines: string[] = []
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1]
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      lines.push(line)
    } else if (marker !== undefined) {
      fence = marker
      lines.push(open(line))
    } else {
      const visited = visit(line)
      if (visited !== null) lines.push(visited)
    }
  }
  return lines.join("\n")
}

const labelBareFence = (line: string) => (BARE_FENCE.test(line) ? `${line.trimEnd()}text` : line)

const INDENTED_FENCE = /^ +(`{3,}|~{3,})/m
const OPENING_FENCE = /^( *)(`{3,}|~{3,})/
const CLOSING_FENCE = /^ *(`{3,}|~{3,})[ \t]*$/
const LIST_ITEM = /^ *(?:[-*+]|\d{1,9}[.)])(?: |$)/

function stripIndent(line: string, indent: number) {
  let start = 0
  while (start < indent && line[start] === " ") start++
  return line.slice(start)
}

function liftFencesOutOfLists(markdown: string) {
  if (!INDENTED_FENCE.test(markdown)) return markdown
  let inList = false
  let fence: { marker: string; indent: number } | null = null
  const lines: string[] = []
  for (const line of markdown.split("\n")) {
    if (fence !== null) {
      const closing = CLOSING_FENCE.exec(line)?.[1]
      lines.push(stripIndent(line, fence.indent))
      if (closing !== undefined && closing[0] === fence.marker[0] && closing.length >= fence.marker.length) fence = null
      continue
    }
    const opening = OPENING_FENCE.exec(line)
    if (opening !== null && (inList || opening[1].length <= 3)) {
      const indent = inList ? opening[1].length : 0
      fence = { marker: opening[2], indent }
      lines.push(line.slice(indent))
      continue
    }
    if (LIST_ITEM.test(line)) inList = true
    else if (/^\S/.test(line)) inList = false
    lines.push(line)
  }
  return lines.join("\n")
}

export function rewriteMarkdownExtras(text: string) {
  const markdown = liftFencesOutOfLists(text)
  const hasBareUrls = /https?:\/\//i.test(markdown)
  const labelsFences = BARE_FENCE.test(markdown)
  const rewritten =
    hasBareUrls || labelsFences
      ? mapProseLines(markdown, (line) => (hasBareUrls ? outsideCode(line, rewriteBareUrls) : line), labelBareFence)
      : markdown
  return rewriteKeysAndFootnotes(rewritten)
}

function rewriteKeysAndFootnotes(markdown: string) {
  if (!/<kbd>|\[\^/i.test(markdown)) return markdown

  const definitions = new Map<string, string>()
  const withoutDefinitions = mapProseLines(markdown, (line) => {
    const definition = FOOTNOTE_DEFINITION.exec(line)
    if (definition === null) return line
    definitions.set(definition[1], definition[2])
    return null
  })

  const numbers = new Map<string, number>()
  const body = mapProseLines(withoutDefinitions, (line) =>
    outsideCode(line, (prose) =>
      keysAsCode(prose).replace(FOOTNOTE_REFERENCE, (reference, id: string) => {
        if (!definitions.has(id)) return reference
        const number = numbers.get(id) ?? numbers.size + 1
        numbers.set(id, number)
        return superscript(number)
      }),
    ),
  )

  for (const id of definitions.keys()) if (!numbers.has(id)) numbers.set(id, numbers.size + 1)
  if (numbers.size === 0) return body
  const notes = [...numbers].map(([id, number]) => `${number}. ${outsideCode(definitions.get(id) ?? "", keysAsCode)}`)
  return `${body.trimEnd()}\n\n---\n\n${notes.join("\n")}\n`
}
