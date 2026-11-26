import { Lexer, type Token, type Tokens } from "marked"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { githubAssetIdOf } from "@shared/channels.ts"
import { resolveImageSource } from "@/lib/markdown-paths"
import { familyOf, rpcFamily } from "@/lib/remote"

const previewRead = rpcFamily("fs.preview")
const assetUrlRead = rpcFamily("github.assetUrl")

const preview = familyOf((root: string, path: string) => previewRead({ root, path }).pipe(Atom.setIdleTTL("5 minutes")))

const githubAsset = familyOf((id: string) => assetUrlRead({ id }).pipe(Atom.setIdleTTL("1 minute")))

type HostedSource = { readonly kind: "file"; readonly root: string; readonly path: string } | { readonly kind: "githubAsset"; readonly id: string }

const urlOf = (get: Atom.FnContext, source: HostedSource): string | undefined =>
  source.kind === "file"
    ? AsyncResult.getOrElse(AsyncResult.map(get(preview(source.root, source.path)), (found) => found.dataUrl), () => undefined)
    : (AsyncResult.getOrElse(get(githubAsset(source.id)), () => null) ?? undefined)

const loadedUrls = familyOf((sources: readonly HostedSource[]) =>
  Atom.make((get) => sources.map((source) => urlOf(get, source))),
)

interface HostedImage {
  readonly raw: string
  readonly alt: string
  readonly source: HostedSource
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

function sourceOf(href: string, root: string | null, folder: string | undefined): HostedSource | null {
  const id = githubAssetIdOf(href)
  if (id !== null) return { kind: "githubAsset", id }
  const source = resolveImageSource(href, root, folder)
  return source.kind === "file" ? source : null
}

function hostedImages(text: string, root: string | null, folder: string | undefined): HostedImage[] {
  if (!text.includes("![") || (root === null && !text.includes("/user-attachments/assets/"))) return []
  return imageTokens(Lexer.lex(text, { gfm: true })).flatMap((image) => {
    const source = sourceOf(image.href, root, folder)
    return source === null ? [] : [{ raw: image.raw, alt: image.text, source }]
  })
}

const escapeAlt = (alt: string) => alt.replace(/[[\]\\]/g, "\\$&")

export function useHostedImages(text: string, root: string | null, folder: string | undefined): string {
  const images = hostedImages(text, root, folder)
  const urls = useAtomValue(loadedUrls(images.map((image) => image.source)))
  return images.reduce((markdown, image, index) => {
    const url = urls[index]
    return url === undefined ? markdown : markdown.split(image.raw).join(`![${escapeAlt(image.alt)}](${url})`)
  }, text)
}
