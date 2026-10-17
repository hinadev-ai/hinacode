export type ImageSource =
  | { kind: "uri"; uri: string }
  | { kind: "file"; root: string; path: string }
  | { kind: "unavailable"; reason: "noRoot" | "outsideRoot" | "invalid" }

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** `.` dropped and `..` popped. Null when `..` climbs above the first segment. */
function normalize(segments: readonly string[]): string[] | null {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") out.push(segment)
    else if (out.pop() === undefined) return null
  }
  return out
}

/**
 * `href` as a `/`-separated path relative to `root`, with no `.`, `..` or empty segments, which is the only form
 * `fs.preview` and `fs.read` accept.
 */
function relativeToRoot(href: string, root: string): string | "outsideRoot" | "invalid" {
  let path = href.trim()
  if (/^file:\/\//i.test(path)) path = path.slice("file://".length).replace(/^localhost(?=\/)/i, "")
  else if (SCHEME.test(path)) return "invalid"
  path = path.split(/[?#]/)[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    return "invalid"
  }
  if (path.includes("\0")) return "invalid"

  let segments: string[] | null
  if (path.startsWith("/")) {
    const absolute = normalize(path.split("/"))
    const base = normalize(root.split("/"))
    if (absolute === null || base === null) return "outsideRoot"
    if (base.some((segment, index) => absolute[index] !== segment)) return "outsideRoot"
    segments = absolute.slice(base.length)
  } else {
    segments = normalize(path.split("/"))
    if (segments === null) return "outsideRoot"
  }
  return segments.length === 0 ? "invalid" : segments.join("/")
}

/**
 * Where a Markdown image's `src` loads from. URLs load directly; a path loads from `root`, the thread's working
 * folder, and must stay inside it.
 */
export function resolveImageSource(src: string, root: string | null): ImageSource {
  const trimmed = src.trim()
  if (/^(https?:\/\/|data:)/i.test(trimmed)) return { kind: "uri", uri: trimmed }
  if (trimmed === "") return { kind: "unavailable", reason: "invalid" }
  if (root === null) return { kind: "unavailable", reason: "noRoot" }
  const path = relativeToRoot(trimmed, root)
  if (path === "invalid" || path === "outsideRoot") return { kind: "unavailable", reason: path }
  return { kind: "file", root, path }
}

/** The file a relative Markdown link points at, relative to `root`, or null when it is not a file in it. */
export function resolveFileLink(href: string, root: string | null): string | null {
  if (root === null) return null
  const path = relativeToRoot(href, root)
  return path === "invalid" || path === "outsideRoot" ? null : path
}
