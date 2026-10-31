export interface PathMatch {
  readonly path: string
  /** Indices into `path` of the characters the query matched, ascending. */
  readonly positions: readonly number[]
  readonly score: number
}

const MAX_RESULTS = 50
const BASENAME_BONUS = 1000
const CONSECUTIVE_BONUS = 10
const BOUNDARY_BONUS = 6

const isBoundary = (text: string, index: number) => {
  if (index === 0) return true
  const before = text[index - 1]
  if (before === "/" || before === "." || before === "-" || before === "_" || before === " ") return true
  const char = text[index]
  return before === before.toLowerCase() && char !== char.toLowerCase()
}

/**
 * The best placement of `query` as a subsequence of `text`, trying every start of its first character and
 * matching the rest greedily. Earlier, consecutive and word-start matches score higher.
 */
function subsequence(text: string, lower: string, query: string) {
  let best: { positions: number[]; score: number } | null = null
  for (let start = lower.indexOf(query[0]); start !== -1; start = lower.indexOf(query[0], start + 1)) {
    const positions = [start]
    let at = start + 1
    for (let q = 1; q < query.length; q++) {
      const found = lower.indexOf(query[q], at)
      if (found === -1) return best
      positions.push(found)
      at = found + 1
    }
    let score = -start
    for (let i = 0; i < positions.length; i++) {
      if (i > 0 && positions[i] === positions[i - 1] + 1) score += CONSECUTIVE_BONUS
      if (isBoundary(text, positions[i])) score += BOUNDARY_BONUS
    }
    if (best === null || score > best.score) best = { positions, score }
  }
  return best
}

function matchPath(path: string, query: string): PathMatch | null {
  const lower = path.toLowerCase()
  const nameStart = path.lastIndexOf("/") + 1
  const name = path.slice(nameStart)
  const inName = subsequence(name, lower.slice(nameStart), query)
  if (inName !== null) {
    return {
      path,
      positions: inName.positions.map((index) => index + nameStart),
      score: BASENAME_BONUS + inName.score,
    }
  }
  const inPath = subsequence(path, lower, query)
  return inPath === null ? null : { path, positions: inPath.positions, score: inPath.score }
}

/**
 * Ranks `paths` for a "go to file" query: the query's characters must appear in order, case-insensitively.
 * A hit inside the file name ranks above one that needs the folders. Whitespace in the query is ignored.
 * Returns at most 50 matches, best first; ties go to the shorter path.
 */
export function matchPaths(paths: readonly string[], query: string): PathMatch[] {
  const needle = query.replace(/\s+/g, "").toLowerCase()
  if (needle === "") return []
  const matches: PathMatch[] = []
  for (const path of paths) {
    const match = matchPath(path, needle)
    if (match !== null) matches.push(match)
  }
  matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
  return matches.slice(0, MAX_RESULTS)
}
