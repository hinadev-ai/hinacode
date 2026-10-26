import { Lexer, type Token, type Tokens } from "marked"
import { useEffect, useMemo, useState } from "react"
import { call } from "@/lib/connection"
import { resolveImageSource } from "@/lib/markdown-paths"

const CACHE_SIZE = 24

/** Data URLs of workspace images by `root + "\0" + path`, oldest first. */
const previews = new Map<string, string>()

function rememberPreview(key: string, dataUrl: string) {
  previews.delete(key)
  previews.set(key, dataUrl)
  const oldest = previews.keys().next().value
  if (previews.size > CACHE_SIZE && oldest !== undefined) previews.delete(oldest)
}

interface WorkspaceImage {
  readonly raw: string
  readonly alt: string
  readonly root: string
  readonly path: string
  readonly key: string
}

function imageTokens(tokens: readonly Token[]): Tokens.Image[] {
  return tokens.flatMap((token) => {
    const children = [
      ...("tokens" in token && Array.isArray(token.tokens) ? token.tokens : []),
      ...(token.type === "list" ? (token as Tokens.List).items : []),
      ...(token.type === "table"
        ? [...(token as Tokens.Table).header, ...(token as Tokens.Table).rows.flat()].flatMap((cell) => cell.tokens)
        : []),
    ]
    return token.type === "image" ? [token as Tokens.Image] : imageTokens(children)
  })
}

function workspaceImages(text: string, root: string | null, folder: string | undefined): WorkspaceImage[] {
  if (root === null || !text.includes("![")) return []
  return imageTokens(Lexer.lex(text, { gfm: true })).flatMap((image) => {
    const source = resolveImageSource(image.href, root, folder)
    if (source.kind !== "file") return []
    const key = `${source.root}\0${source.path}`
    return [{ raw: image.raw, alt: image.text, root: source.root, path: source.path, key }]
  })
}

const escapeAlt = (alt: string) => alt.replace(/[[\]\\]/g, "\\$&")

/**
 * `text` with each image that points into the workspace swapped for its data URL once `fs.preview` returns it,
 * since the phone cannot load the desktop's files by path. URLs and images outside `root` stay as written.
 */
export function useWorkspaceImages(text: string, root: string | null, folder: string | undefined): string {
  const images = useMemo(() => workspaceImages(text, root, folder), [text, root, folder])
  const [loaded, setLoaded] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    let live = true
    for (const image of images) {
      if (previews.has(image.key)) continue
      call("fs.preview", { root: image.root, path: image.path }).then(
        ({ dataUrl }) => {
          rememberPreview(image.key, dataUrl)
          if (live) setLoaded((current) => new Map(current).set(image.key, dataUrl))
        },
        () => {},
      )
    }
    return () => {
      live = false
    }
  }, [images])

  return images.reduce((markdown, image) => {
    const dataUrl = loaded.get(image.key) ?? previews.get(image.key)
    return dataUrl === undefined ? markdown : markdown.split(image.raw).join(`![${escapeAlt(image.alt)}](${dataUrl})`)
  }, text)
}
