export interface FilePatch {
  readonly patch: string
  readonly added: number
  readonly removed: number
}

/**
 * A multi-file `git diff` split per file, keyed by path. Renames are off in `threads.changes`, so a file's header is
 * `diff --git a/<path> b/<path>`. Lines count only inside hunks, so the `---` and `+++` headers do not.
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
  const sides = header.slice("diff --git a/".length)
  return sides.slice(0, (sides.length - " b/".length) / 2)
}
