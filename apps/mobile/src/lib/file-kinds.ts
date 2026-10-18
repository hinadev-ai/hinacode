/** How the file viewer shows a file. */
export type FileKind = "image" | "svg" | "markdown" | "text"

export type FileIcon =
  | "RiFolderLine"
  | "RiFileCodeLine"
  | "RiImageLine"
  | "RiMarkdownLine"
  | "RiFileTextLine"
  | "RiFileLine"

const images = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"])
const markdown = new Set(["md", "mdx", "markdown"])
const code = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonc py rb go rs java kt kts swift c h cc cpp hpp cs m mm php sh bash zsh " +
    "fish css scss sass less html htm xml vue svelte astro sql yaml yml toml lua zig ex exs erl hs ml dart scala r " +
    "pl tf nix graphql gql proto tla cfg ini"
  ).split(" "),
)
const text = new Set(["txt", "log", "csv", "tsv", "rst", "adoc", "org", "env", "lock", "gitignore", "gitattributes"])
const textNames = new Set(["license", "licence", "readme", "changelog", "authors", "notice", "copying", "makefile"])

/** The last segment of a `/`-separated path. */
export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** The folder part of a `/`-separated path, "" at the top level. */
export const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))

/** The lowercased extension of `path` without its dot, or "" when it has none. A dotfile's name is its extension. */
export function extension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
}

export function fileKind(path: string): FileKind {
  const ext = extension(path)
  if (images.has(ext)) return "image"
  if (ext === "svg") return "svg"
  if (markdown.has(ext)) return "markdown"
  return "text"
}

/** The listing's icon for an entry. Symlinks get the file icons, since they are never followed. */
export function entryIcon(path: string, kind: "file" | "dir" | "symlink"): FileIcon {
  if (kind === "dir") return "RiFolderLine"
  const ext = extension(path)
  if (images.has(ext) || ext === "svg") return "RiImageLine"
  if (markdown.has(ext)) return "RiMarkdownLine"
  if (code.has(ext)) return "RiFileCodeLine"
  if (text.has(ext) || textNames.has(basename(path).toLowerCase())) return "RiFileTextLine"
  return "RiFileLine"
}

const viewBoxPattern = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i

/**
 * Width over height of an SVG, from its `viewBox`, else its `width` and `height` attributes. Null when neither
 * gives a usable size, such as percentages.
 */
export function svgAspectRatio(xml: string): number | null {
  const tag = /<svg\b[^>]*>/i.exec(xml)?.[0]
  if (tag === undefined) return null
  const viewBox = viewBoxPattern.exec(tag)
  const width = viewBox === null ? attribute(tag, "width") : Number(viewBox[1])
  const height = viewBox === null ? attribute(tag, "height") : Number(viewBox[2])
  return width > 0 && height > 0 ? width / height : null
}

const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)(px)?["']`, "i").exec(tag)
  return match === null ? NaN : Number(match[1])
}
