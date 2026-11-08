export interface FilePatch {
  readonly patch: string
  readonly added: number
  readonly removed: number
}

/**
 * A multi-file `git diff` split per file, keyed by path. Renames are off in `threads.changes`, so a file's header is
 * `diff --git a/<path> b/<path>`, with both sides quoted when the path needs it. Lines count only inside hunks, so the `---` and `+++` headers do not.
 */
export function filePatches(patch: string): Map<string, FilePatch> {
  const files = new Map<string, FilePatch>()
  let path: string | null = null
  let lines: string[] = []
  let added = 0
  let removed = 0
  let inHunk = false
  const flush = () => {
    if (path !== null) files.set(path, { patch: lines.join("\n"), added, removed })
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush()
      path = headerPath(line)
      lines = [line]
      added = 0
      removed = 0
      inHunk = false
      continue
    }
    lines.push(line)
    if (line.startsWith("@@")) inHunk = true
    else if (inHunk && line.startsWith("+")) added++
    else if (inHunk && line.startsWith("-")) removed++
  }
  flush()
  return files
}

const headerPath = (header: string) => {
  const sides = header.slice("diff --git ".length)
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(sides)
  if (quoted !== null) return unquote(quoted[1]!).slice("a/".length)
  return sides.slice("a/".length, ("a/".length + sides.length - " b/".length) / 2)
}

const escapes: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" }

/**
 * Git wraps a path holding `"`, `\` or a control character in quotes with C escapes. Octal escapes are the bytes of
 * one UTF-8 character, so every character goes through percent encoding and decodes back together.
 */
const unquote = (quoted: string) => {
  const encoded = quoted.replace(/\\([0-7]{3}|.)|[^\\]+/g, (token, escape?: string) => {
    if (escape === undefined) return encodeURIComponent(token)
    if (/^[0-7]{3}$/.test(escape)) return `%${Number.parseInt(escape, 8).toString(16).padStart(2, "0")}`
    return encodeURIComponent(escapes[escape] ?? escape)
  })
  try {
    return decodeURIComponent(encoded)
  } catch {
    return quoted
  }
}
