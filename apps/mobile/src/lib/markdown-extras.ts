const FENCE = /^ {0,3}(`{3,}|~{3,})/
const BARE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/m
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/g
const KBD = /<kbd>(.*?)<\/kbd>/gi
const CODE_SPAN = /(`+)[^`]+?\1(?!`)/g
const LINK_OR_AUTOLINK = /!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>/g
const PULL_REQUEST_URL = /(?<![\w/"'=])https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?![\w/?#=&-])/gi
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹"

const superscript = (value: number) =>
  String(value)
    .split("")
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)])
    .join("")

const codeSpan = (text: string) => (text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``)

const keysAsCode = (prose: string) => prose.replace(KBD, (_, key: string) => codeSpan(key))

/** Applies `rewrite` to the parts of `text` that `protect` does not match, leaving those matches as written. */
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

const shortenPullRequestUrls = (prose: string) =>
  outside(LINK_OR_AUTOLINK, prose, (text) =>
    text.replace(
      PULL_REQUEST_URL,
      (url, owner: string, name: string, number: string) => `[${owner}/${name}#${number}](${url})`,
    ),
  )

/**
 * Calls `visit` with each line outside fenced code blocks and whatever it returns replaces the line. `open`, when
 * given, rewrites each opening fence line.
 */
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

/**
 * Rewrites what the phone's Markdown renderer has no syntax for into what it has, as the desktop renders it:
 * a bare GitHub pull request URL becomes a link named `owner/repo#n`, `<kbd>` becomes a code span, which the
 * renderer draws as a key cap, a footnote reference `[^id]` becomes a superscript number, and the definitions
 * move to a numbered list at the end, in the order they are first cited. A fence with no language is labelled
 * `text`, so the code block header names it instead of standing empty. Code blocks, code spans and existing
 * links stay as written, and other HTML stays text.
 */
export function rewriteMarkdownExtras(markdown: string) {
  const linksPullRequests = /github\.com\/\S+\/pull\//i.test(markdown)
  const labelsFences = BARE_FENCE.test(markdown)
  const rewritten =
    linksPullRequests || labelsFences
      ? mapProseLines(
          markdown,
          (line) => (linksPullRequests ? outsideCode(line, shortenPullRequestUrls) : line),
          labelBareFence,
        )
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
