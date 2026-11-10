import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { PullRequestFile } from "../../shared/domain.ts"
import { extensionOf } from "../../shared/media.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { pullRequestFileContentAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { Markdown } from "./Markdown.tsx"
import type { PullRequestReview } from "./PullRequestReview.tsx"

const imageTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
}

const markdownExtensions = new Set(["md", "markdown", "mdx"])

type PreviewKind = "image" | "markdown"

export const previewKind = (path: string): PreviewKind | null => {
  const extension = extensionOf(path)
  if (extension in imageTypes) return "image"
  return markdownExtensions.has(extension) ? "markdown" : null
}

const decodeText = (base64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)))

interface Side {
  readonly label: string
  readonly ref: string
  readonly path: string
}

const sidesOf = (review: PullRequestReview, file: PullRequestFile, kind: PreviewKind): ReadonlyArray<Side> => {
  const before = { label: m.pr_preview_before(), ref: review.baseRef, path: file.previousPath ?? file.path }
  const after = { label: m.pr_preview_after(), ref: review.head, path: file.path }
  if (file.status === "added" || file.status === "copied") return [after]
  if (file.status === "removed") return [before]
  return kind === "image" ? [before, after] : [after]
}

export function FilePreview({
  review,
  file,
  kind,
}: {
  review: PullRequestReview
  file: PullRequestFile
  kind: PreviewKind
}) {
  const sides = sidesOf(review, file, kind)
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-px bg-border">
      {sides.map((side) => (
        <figure key={side.label} className="flex min-w-0 flex-col gap-2 bg-background p-3">
          {sides.length > 1 && <figcaption className="text-xs text-muted-foreground">{side.label}</figcaption>}
          <PreviewContent review={review} side={side} kind={kind} />
        </figure>
      ))}
    </div>
  )
}

function PreviewContent({ review, side, kind }: { review: PullRequestReview; side: Side; kind: PreviewKind }) {
  const content = useAtomValue(pullRequestFileContentAtom(review.environment, review.url, side.ref, side.path))
  return AsyncResult.builder(content)
    .onSuccess((base64) => {
      if (base64 === null) return <p className="text-xs text-muted-foreground">{m.pr_preview_too_large()}</p>
      if (kind === "markdown") return <Markdown text={decodeText(base64)} className="prose-sm" />
      return (
        <img
          src={`data:${imageTypes[extensionOf(side.path)]};base64,${base64}`}
          alt={side.path}
          className={cn(
            "max-h-96 max-w-full self-start rounded-sm bg-white bg-[repeating-conic-gradient(var(--color-neutral-200)_0_25%,transparent_0_50%)] bg-size-[16px_16px] object-contain",
            extensionOf(side.path) === "svg" && "h-24 w-auto",
          )}
        />
      )
    })
    .onError((error) => (
      <p role="alert" className="text-xs wrap-anywhere text-destructive">
        {m.pr_preview_failed({ message: errorMessage(error) })}
      </p>
    ))
    .orElse(() => <p className="text-xs text-muted-foreground">{m.diff_loading()}</p>)
}
