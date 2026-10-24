/** One row of a diff. Hunk headers and notes such as "No newline at end of file" have no line numbers. */
export interface PatchLine {
  readonly kind: "hunk" | "note" | "context" | "addition" | "deletion"
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** One file's section of a unified diff as numbered lines, from its first hunk on. */
export function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of patch.split("\n")) {
    const header = HUNK_HEADER.exec(text)
    if (header !== null) {
      inHunk = true
      oldLine = Number(header[1])
      newLine = Number(header[2])
      lines.push({ kind: "hunk", text, oldLine: null, newLine: null })
    } else if (!inHunk) {
      continue
    } else if (text.startsWith("+")) {
      lines.push({ kind: "addition", text: text.slice(1), oldLine: null, newLine: newLine++ })
    } else if (text.startsWith("-")) {
      lines.push({ kind: "deletion", text: text.slice(1), oldLine: oldLine++, newLine: null })
    } else if (text.startsWith("\\")) {
      lines.push({ kind: "note", text, oldLine: null, newLine: null })
    } else if (text.startsWith(" ")) {
      lines.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return lines
}
