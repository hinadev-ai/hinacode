import { basename, extension } from "@/lib/file-kinds"
import type { SyntaxClass, SyntaxSpan } from "@/lib/highlight"

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue debugger declare default delete do else enum " +
    "export extends finally for from function get if implements import in infer instanceof interface is keyof let " +
    "namespace new of private protected public readonly return satisfies set static switch throw try type typeof " +
    "var void while with yield " +
    "and def del elif except global lambda nonlocal not or pass raise assert " +
    "chan defer fallthrough func go goto map range select struct package " +
    "crate dyn fn impl loop match mod move mut pub ref trait unsafe use where " +
    "final native synchronized throws transient volatile fun val when object sealed override open internal " +
    "lateinit companion guard init deinit extension protocol inout subscript fileprivate using virtual operator " +
    "out params event lock " +
    "auto char double float int long short signed unsigned sizeof typedef union extern register inline bool string " +
    "begin end ensure rescue unless until module then elsif echo foreach fi esac done local"
  ).split(" "),
)

const SQL_KEYWORDS = new Set(
  (
    "SELECT FROM WHERE INSERT INTO UPDATE DELETE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET " +
    "VALUES CREATE TABLE ALTER DROP INDEX PRIMARY KEY FOREIGN REFERENCES NOT NULL AND OR AS DISTINCT UNION ALL CASE " +
    "WHEN THEN ELSE END BEGIN COMMIT ROLLBACK SET LIKE BETWEEN EXISTS IS IN ASC DESC DEFAULT WITH RETURNING"
  ).split(" "),
)

const CONSTANTS = new Set(
  "true false True False null nil None undefined NaN Infinity self this super".split(" "),
)

const HASH_COMMENT_LANGUAGES = new Set(
  (
    "sh bash zsh fish ps1 py rb pl r jl ex exs nix tf yaml yml toml ini cfg conf properties graphql gql cmake mk " +
    "env gitignore gitattributes dockerignore editorconfig makefile dockerfile"
  ).split(" "),
)

const startsCommentWithHash = (path: string) =>
  HASH_COMMENT_LANGUAGES.has(extension(path) || basename(path).toLowerCase())

const OPERATOR_CHARS = new Set("=+-*/%!<>&|^~?:")

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r"
const isDigit = (c: string) => c >= "0" && c <= "9"
const isIdentStart = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c > "\u007f"
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c)
const isUpper = (c: string) => c >= "A" && c <= "Z"
const isAllCaps = (word: string) => /^[A-Z][A-Z0-9_]+$/.test(word)

export function lex(code: string, path: string): SyntaxSpan[] {
  const hashComments = startsCommentWithHash(path)
  const spans: SyntaxSpan[] = []
  const push = (type: SyntaxClass, start: number, end: number) => {
    if (end <= start) return
    const last = spans[spans.length - 1]
    if (last !== undefined && last.type === type) spans[spans.length - 1] = { type, start: last.start, end }
    else spans.push({ type, start, end })
  }
  const length = code.length
  const lineEnd = (from: number) => {
    const newline = code.indexOf("\n", from)
    return newline === -1 ? length : newline
  }
  const until = (from: number, close: string) => {
    const found = code.indexOf(close, from)
    return found === -1 ? length : found + close.length
  }
  const atLineStart = (at: number) => {
    let back = at - 1
    while (back >= 0 && (code[back] === " " || code[back] === "\t")) back--
    return back < 0 || code[back] === "\n"
  }
  const followsSpace = (at: number) => at === 0 || isSpace(code[at - 1])
  const endsWord = (at: number) => at >= length || isSpace(code[at])

  const commentEnd = (at: number) => {
    const c = code[at]
    const next = code[at + 1]
    if (c === "/" && next === "/") return lineEnd(at)
    if (c === "/" && next === "*") return until(at + 2, "*/")
    if (c === "<" && code.startsWith("<!--", at)) return until(at + 4, "-->")
    if (c === "#" && hashComments && (atLineStart(at) || (followsSpace(at) && endsWord(at + 1)))) return lineEnd(at)
    if (c === "-" && next === "-" && code[at + 2] === " " && followsSpace(at)) return lineEnd(at)
    return -1
  }

  const quoteUnclosedUntilLineEnd: Record<string, number> = { "'": -1, '"': -1 }

  const stringEnd = (at: number) => {
    const quote = code[at]
    if ((quote === '"' || quote === "'") && code[at + 1] === quote && code[at + 2] === quote) {
      return until(at + 3, quote.repeat(3))
    }
    const multiline = quote === "`"
    if (!multiline && at < quoteUnclosedUntilLineEnd[quote]) return -1
    let j = at + 1
    while (j < length) {
      const c = code[j]
      if (c === "\\") j += 2
      else if (c === quote) return j + 1
      else if (c === "\n" && !multiline) break
      else j++
    }
    if (multiline) return length
    quoteUnclosedUntilLineEnd[quote] = j
    return -1
  }

  const numberEnd = (at: number) => {
    let j = at
    const prefix = code[at] === "0" ? code[at + 1]?.toLowerCase() : undefined
    if (prefix === "x" || prefix === "b" || prefix === "o") {
      j += 2
      while (j < length && (isIdentPart(code[j]))) j++
      return j
    }
    while (j < length && (isDigit(code[j]) || code[j] === "_")) j++
    if (code[j] === "." && isDigit(code[j + 1] ?? "")) {
      j++
      while (j < length && (isDigit(code[j]) || code[j] === "_")) j++
    }
    if ((code[j] === "e" || code[j] === "E") && (isDigit(code[j + 1] ?? "") || /[+-]/.test(code[j + 1] ?? ""))) {
      const signed = code[j + 1] === "+" || code[j + 1] === "-"
      if (!signed || isDigit(code[j + 2] ?? "")) {
        j += signed ? 2 : 1
        while (j < length && isDigit(code[j])) j++
      }
    }
    while (j < length && isIdentPart(code[j])) j++
    return j
  }

  const classifyWord = (word: string, end: number): SyntaxClass => {
    if (KEYWORDS.has(word) || SQL_KEYWORDS.has(word)) return "keyword"
    if (CONSTANTS.has(word) || isAllCaps(word)) return "constant"
    let j = end
    while (j < length && (code[j] === " " || code[j] === "\t")) j++
    if (code[j] === "(") return "function"
    if (isUpper(word[0])) return "type"
    return "plain"
  }

  let i = 0
  while (i < length) {
    const c = code[i]

    const comment = commentEnd(i)
    if (comment !== -1) {
      push("comment", i, comment)
      i = comment
      continue
    }

    if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(i)
      if (end !== -1) {
        push("string", i, end)
        i = end
        continue
      }
      push("plain", i, i + 1)
      i++
      continue
    }

    if (isDigit(c) || (c === "." && isDigit(code[i + 1] ?? ""))) {
      const end = numberEnd(i)
      push("number", i, end)
      i = end
      continue
    }

    if (isIdentStart(c)) {
      let end = i + 1
      while (end < length && isIdentPart(code[end])) end++
      push(classifyWord(code.slice(i, end), end), i, end)
      i = end
      continue
    }

    if (OPERATOR_CHARS.has(c)) {
      let end = i + 1
      while (end < length && OPERATOR_CHARS.has(code[end]) && commentEnd(end) === -1) end++
      push("operator", i, end)
      i = end
      continue
    }

    push("plain", i, i + 1)
    i++
  }
  return spans
}
