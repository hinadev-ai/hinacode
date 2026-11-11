export type ImageSource =
  | { kind: "uri"; uri: string }
  | { kind: "file"; root: string; path: string }
  | { kind: "unavailable"; reason: "noRoot" | "outsideRoot" | "invalid" }

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

function normalize(segments: readonly string[]): string[] | null {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") out.push(segment)
    else if (out.pop() === undefined) return null
  }
  return out
}

function relativeToRoot(href: string, root: string, folder: string): string | "outsideRoot" | "invalid" {
  let path = href.trim()
  if (/^file:\/\//i.test(path)) path = path.slice("file://".length).replace(/^localhost(?=\/)/i, "")
  else if (SCHEME.test(path)) return "invalid"
  path = path.split(/[?#]/)[0]
  if (path === "") return "invalid"
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
    segments = normalize([...folder.split("/"), ...path.split("/")])
    if (segments === null) return "outsideRoot"
  }
  return segments.length === 0 ? "invalid" : segments.join("/")
}

export function resolveImageSource(src: string, root: string | null, folder = ""): ImageSource {
  const trimmed = src.trim()
  if (/^(https?:\/\/|data:)/i.test(trimmed)) return { kind: "uri", uri: trimmed }
  if (trimmed === "") return { kind: "unavailable", reason: "invalid" }
  if (root === null) return { kind: "unavailable", reason: "noRoot" }
  const path = relativeToRoot(trimmed, root, folder)
  if (path === "invalid" || path === "outsideRoot") return { kind: "unavailable", reason: path }
  return { kind: "file", root, path }
}

export function resolveFileLink(href: string, root: string | null, folder = ""): string | null {
  if (root === null) return null
  const path = relativeToRoot(href, root, folder)
  return path === "invalid" || path === "outsideRoot" ? null : path
}
