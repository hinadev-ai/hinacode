import { Lexer, type Token, type Tokens } from "marked"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { resolveImageSource } from "@/lib/markdown-paths"
import { familyOf, rpcFamily } from "@/lib/remote"

const previewRead = rpcFamily("fs.preview")

const preview = familyOf((root: string, path: string) => previewRead({ root, path }).pipe(Atom.setIdleTTL("5 minutes")))

const loadedPreviews = familyOf((images: readonly (readonly [root: string, path: string])[]) =>
  Atom.make((get) =>
    images.map(([root, path]) => AsyncResult.getOrElse(AsyncResult.map(get(preview(root, path)), (found) => found.dataUrl), () => undefined)),
  ),
)

interface WorkspaceImage {
  readonly raw: string
  readonly alt: string
  readonly root: string
  readonly path: string
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
    return [{ raw: image.raw, alt: image.text, root: source.root, path: source.path }]
  })
}

const escapeAlt = (alt: string) => alt.replace(/[[\]\\]/g, "\\$&")

/**
 * `text` with each image that points into the workspace swapped for its data URL once `fs.preview` returns it,
 * since the phone cannot load the desktop's files by path. URLs and images outside `root` stay as written.
 */
export function useWorkspaceImages(text: string, root: string | null, folder: string | undefined): string {
  const images = workspaceImages(text, root, folder)
  const dataUrls = useAtomValue(loadedPreviews(images.map((image) => [image.root, image.path] as const)))
  return images.reduce((markdown, image, index) => {
    const dataUrl = dataUrls[index]
    return dataUrl === undefined ? markdown : markdown.split(image.raw).join(`![${escapeAlt(image.alt)}](${dataUrl})`)
  }, text)
}
