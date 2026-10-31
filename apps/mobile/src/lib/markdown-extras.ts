const FENCE = /^ {0,3}(`{3,}|~{3,})/
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/g
const KBD = /<kbd>(.*?)<\/kbd>/gi
const CODE_SPAN = /(`+)[^`]+?\1(?!`)/g
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹"

const superscript = (value: number) =>
  String(value)
    .split("")
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)])
    .join("")

const codeSpan = (text: string) => (text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``)

const keysAsCode = (prose: string) => prose.replace(KBD, (_, key: string) => codeSpan(key))

/** Applies `rewrite` to a line's prose, leaving its inline code spans as written. */
function outsideCode(line: string, rewrite: (prose: string) => string) {
  let result = ""
  let last = 0
  for (const match of line.matchAll(CODE_SPAN)) {
    result += rewrite(line.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return result + rewrite(line.slice(last))
}

/** Calls `visit` with each line outside fenced code blocks and whatever it returns replaces the line. */
function mapProseLines(markdown: string, visit: (line: string) => string | null) {
  let fence: string | null = null
  const lines: string[] = []
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1]
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      lines.push(line)
    } else if (marker !== undefined) {
      fence = marker
      lines.push(line)
    } else {
      const visited = visit(line)
      if (visited !== null) lines.push(visited)
    }
  }
  return lines.join("\n")
}

/**
 * Rewrites what the phone's Markdown renderer has no syntax for into what it has, as the desktop renders it:
 * `<kbd>` becomes a code span, which the renderer draws as a key cap, a footnote reference `[^id]` becomes a
 * superscript number, and the definitions move to a numbered list at the end, in the order they are first cited.
 * Code blocks and code spans stay as written, and other HTML stays text.
 */
export function rewriteMarkdownExtras(markdown: string) {
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
