import type { DiffSide } from "../../shared/domain.ts"

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)/

export const patchLines = (patch: string, side: DiffSide, startLine: number, endLine: number) => {
  const picked: Array<string> = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const pick = (line: number, text: string) => {
    if (line >= startLine && line <= endLine) picked.push(text)
  }
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
    } else if (!inHunk || line.startsWith("\\")) {
      continue
    } else if (line.startsWith("+")) {
      if (side === "RIGHT") pick(newLine, line.slice(1))
      newLine++
    } else if (line.startsWith("-")) {
      if (side === "LEFT") pick(oldLine, line.slice(1))
      oldLine++
    } else {
      pick(side === "RIGHT" ? newLine : oldLine, line.slice(1))
      oldLine++
      newLine++
    }
  }
  return picked.join("\n")
}
