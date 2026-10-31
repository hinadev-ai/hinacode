import { useAtomSuspense } from "@effect/atom-react"
import { cn } from "cn"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  createContext,
  isValidElement,
  type ComponentProps,
  type ReactNode,
  Suspense,
  use,
  useDeferredValue,
  useState,
} from "react"
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import { externalImageUrl, githubAssetUrl } from "../../shared/channels.ts"
import type { Appearance } from "../../shared/domain.ts"
import { useTheme } from "../lib/appearance.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { imageSource, imageSrcSet } from "../lib/imageSource.ts"
import type { RehypeEmbeddedHtml } from "../lib/embeddedHtml.ts"
import {
  mayContainEmbeddedHtml,
  remarkUnknownTagsAsText,
  segmentServiceBlocks,
  type MarkdownSegment,
  type ServiceBadge,
} from "../lib/htmlInMarkdown.ts"
import { remarkKbd } from "../lib/remarkKbd.ts"
import { remarkPullRequests } from "../lib/remarkPullRequests.ts"
import { familyOf } from "../lib/rpc.ts"
import { useClientSettings } from "../lib/settings.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { useDebouncedValue } from "../lib/useDebouncedValue.ts"
import { ThreadFolder } from "../lib/threadRoot.ts"
import { m } from "../paraglide/messages.js"
import { CopyButton } from "./CopyButton.tsx"
import { FindPartContext, rehypeFindMarks, useFindPattern } from "./FindHighlight.tsx"
import { HighlightedCode } from "./HighlightedCode.tsx"
import { isWebUrl, WebLink } from "./WebLink.tsx"

const bareGitHubAsset = (paragraph: ExtraProps["node"]) => {
  const [link, ...rest] = paragraph?.children ?? []
  if (rest.length > 0 || link?.type !== "element" || link.tagName !== "a") return null
  const [text] = link.children
  const href = link.properties["href"]
  return text?.type === "text" && text.value === href ? githubAssetUrl(href) : null
}

const BaseUrl = createContext<string | null>(null)

const pixelSize = (value: unknown) => {
  const parsed =
    typeof value === "string" || typeof value === "number" ? Number.parseInt(String(value), 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function MarkdownImage({
  src,
  srcSet,
  alt,
  width,
  height,
}: {
  src: string | undefined
  srcSet?: string
  alt: string
  width?: unknown
  height?: unknown
}) {
  const environment = useOpenThreadEnvironment()
  const baseUrl = use(BaseUrl)
  const root = use(ThreadFolder)
  const context = { environment, baseUrl, root }
  const styledWidth = pixelSize(width)
  const styledHeight = styledWidth === undefined ? pixelSize(height) : undefined
  return (
    <img
      src={src === undefined ? undefined : imageSource(src, context)}
      srcSet={srcSet === undefined ? undefined : imageSrcSet(srcSet, context)}
      alt={alt}
      loading="lazy"
      width={styledWidth}
      height={pixelSize(height)}
      style={{
        ...(styledWidth === undefined ? {} : { width: styledWidth }),
        ...(styledHeight === undefined ? {} : { height: styledHeight }),
      }}
      className="inline-block max-h-[min(32rem,60vh)] w-auto max-w-[min(100%,40rem)] rounded-md object-contain"
    />
  )
}

function ThemedSource({ media, srcSet, sizes }: { media?: string; srcSet?: string; sizes?: string }) {
  const { theme } = useClientSettings().appearance
  const { scheme } = useTheme(theme)
  const environment = useOpenThreadEnvironment()
  const baseUrl = use(BaseUrl)
  const root = use(ThreadFolder)
  const wanted = /prefers-color-scheme:\s*(dark|light)/i.exec(media ?? "")?.[1]?.toLowerCase()
  if (wanted !== undefined && wanted !== scheme) return null
  return (
    <source
      media={media}
      srcSet={srcSet === undefined ? undefined : imageSrcSet(srcSet, { environment, baseUrl, root })}
      sizes={sizes}
    />
  )
}

const components: Components = {
  p: ({ children, node }) => {
    const asset = bareGitHubAsset(node)
    return asset ? <GitHubAttachment src={asset} /> : <p>{children}</p>
  },
  img: ({ src, srcSet, alt, width, height }) => (
    <MarkdownImage
      src={typeof src === "string" ? src : undefined}
      srcSet={typeof srcSet === "string" ? srcSet : undefined}
      alt={alt ?? ""}
      width={width}
      height={height}
    />
  ),
  source: ({ media, srcSet, sizes }) => (
    <ThemedSource
      media={typeof media === "string" ? media : undefined}
      srcSet={typeof srcSet === "string" ? srcSet : undefined}
      sizes={typeof sizes === "string" ? sizes : undefined}
    />
  ),
  a: ({ children, href }) =>
    isWebUrl(href) ? (
      <WebLink href={href}>{children}</WebLink>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  input: ({ type, checked }) => (
    <input
      type={type}
      checked={checked}
      disabled
      aria-label={checked ? m.markdown_task_done() : m.markdown_task_open()}
      className="mr-[0.5em] translate-y-px accent-primary"
    />
  ),
  pre: ({ children }) => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>
    const language = /language-(\S+)/.exec(children.props.className ?? "")?.[1]
    const code = String(children.props.children ?? "").replace(/\n$/, "")
    return language === "mermaid" ? <MermaidDiagram code={code} /> : <CodeBlock language={language} code={code} />
  },
  table: ({ children }) => (
    <div className="my-[2em] overflow-x-auto [&>table]:my-0">
      <table>{children}</table>
    </div>
  ),
}

function ServiceBadgeLink({ badge }: { badge: ServiceBadge }) {
  const { theme } = useClientSettings().appearance
  const { scheme } = useTheme(theme)
  const src = (scheme === "dark" ? badge.darkSrc : badge.lightSrc) ?? badge.src
  return (
    <a href={badge.href} target="_blank" rel="noreferrer" className="inline-block shrink-0">
      <img
        src={externalImageUrl(src) ?? src}
        alt={badge.alt}
        loading="lazy"
        width={badge.width ?? undefined}
        height={badge.height ?? undefined}
        className="h-7 w-auto max-w-full"
      />
    </a>
  )
}

function ServiceBadges({ segment }: { segment: Extract<MarkdownSegment, { type: "badges" }> }) {
  return (
    <div className="not-prose my-[1em] border-t border-border pt-[1em]">
      <div className="flex flex-wrap items-center gap-2">
        {segment.badges.map((badge) => (
          <ServiceBadgeLink key={badge.href} badge={badge} />
        ))}
      </div>
      {segment.note !== null && segment.note !== "" && (
        <p className="mt-1.5 text-xs text-muted-foreground">{segment.note}</p>
      )}
    </div>
  )
}

type RemarkPlugins = ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
type RehypePlugins = ComponentProps<typeof ReactMarkdown>["rehypePlugins"]

interface MarkdownSegmentsProps {
  readonly segments: ReadonlyArray<MarkdownSegment>
  readonly remarkPlugins: RemarkPlugins
  readonly rehypePlugins: RehypePlugins
}

function MarkdownSegments({ segments, remarkPlugins, rehypePlugins }: MarkdownSegmentsProps) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "badges" ? (
          <ServiceBadges key={index} segment={segment} />
        ) : (
          <ReactMarkdown
            key={index}
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
          >
            {segment.text}
          </ReactMarkdown>
        ),
      )}
    </>
  )
}

let embeddedHtml: Promise<RehypeEmbeddedHtml | null> | undefined

const loadEmbeddedHtml = () => {
  if (embeddedHtml === undefined) {
    embeddedHtml = import("../lib/embeddedHtml.ts").then((loaded) => loaded.rehypeEmbeddedHtml).catch(() => null)
  }
  return embeddedHtml
}

function EmbeddedMarkdownSegments({
  segments,
  remarkPlugins,
  findPlugins,
}: {
  segments: ReadonlyArray<MarkdownSegment>
  remarkPlugins: RemarkPlugins
  findPlugins: RehypePlugins
}) {
  const rehypeEmbeddedHtml = use(loadEmbeddedHtml())
  return (
    <MarkdownSegments
      segments={segments}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypeEmbeddedHtml === null ? findPlugins : [rehypeEmbeddedHtml, ...(findPlugins ?? [])]}
    />
  )
}

export function Markdown({
  text,
  baseUrl = null,
  className,
}: {
  text: string
  baseUrl?: string | null
  className?: string
}) {
  const pattern = useFindPattern()
  const part = use(FindPartContext)
  const findPlugins = pattern === null ? [] : [rehypeFindMarks(pattern, part)]
  const repository = useThreadRepository()
  const remarkPlugins = repository
    ? [remarkGfm, remarkKbd, remarkUnknownTagsAsText, remarkPullRequests(repository)]
    : [remarkGfm, remarkKbd, remarkUnknownTagsAsText]
  const segments = segmentServiceBlocks(text)
  const needsEmbeddedHtml = segments.some(
    (segment) => segment.type === "markdown" && mayContainEmbeddedHtml(segment.text),
  )
  const plain = <MarkdownSegments segments={segments} remarkPlugins={remarkPlugins} rehypePlugins={findPlugins} />
  return (
    <BaseUrl value={baseUrl}>
      <div className={cn("prose-hina prose max-w-none", className)}>
        {needsEmbeddedHtml ? (
          <Suspense fallback={plain}>
            <EmbeddedMarkdownSegments segments={segments} remarkPlugins={remarkPlugins} findPlugins={findPlugins} />
          </Suspense>
        ) : (
          plain
        )}
      </div>
    </BaseUrl>
  )
}

function GitHubAttachment({ src }: { src: string }) {
  const [isImage, setIsImage] = useState(false)
  const className = "my-2 block max-h-96 max-w-full rounded-md border border-border"
  return isImage ? (
    <img src={src} alt={m.markdown_attachment()} loading="lazy" className={className} />
  ) : (
    // oxlint-disable-next-line jsx-a11y/media-has-caption -- GitHub attachments carry no caption track.
    <video
      src={src}
      controls
      preload="metadata"
      aria-label={m.markdown_attachment()}
      onError={() => setIsImage(true)}
      className={className}
    />
  )
}

function CodeFigure({ label, code, children }: { label?: string; code: string; children: ReactNode }) {
  return (
    <figure className="not-prose my-4 overflow-hidden rounded-[0.25em] bg-muted">
      <figcaption className="flex h-8 items-center justify-between pr-1 pl-[0.8em]">
        <span className="truncate font-mono text-xs text-muted-foreground">{label}</span>
        <CopyButton value={code} label={m.markdown_copy_code()} />
      </figcaption>
      {children}
    </figure>
  )
}

function CodeBlock({ language, code }: { language: string | undefined; code: string }) {
  return (
    <CodeFigure label={language} code={code}>
      <pre className="overflow-x-auto px-[0.8em] pb-[0.6em] font-mono text-[0.91em]">
        <code>
          <HighlightedCode code={code} language={language} />
        </code>
      </pre>
    </CodeFigure>
  )
}

// FIXME: Pele measures labels in this font to size nodes
const diagramFont = (uiFont: Appearance["uiFont"]) =>
  uiFont === null
    ? getComputedStyle(document.documentElement).getPropertyValue("--app-font-sans")
    : JSON.stringify(uiFont)

const RENDER_DELAY_MS = 250

const diagramAtom = familyOf((code: string, uiFont: Appearance["uiFont"]) =>
  Atom.make(
    Effect.tryPromise(() =>
      import("pele/lazy").then(({ renderAsync }) =>
        renderAsync(code, { fontFamily: diagramFont(uiFont), fontSize: 12, links: false, images: false }),
      ),
    ),
  ),
)

function MermaidDiagram({ code }: { code: string }) {
  const { uiFont } = useClientSettings().appearance
  const settled = useDeferredValue(useDebouncedValue(code, RENDER_DELAY_MS))

  return (
    <CodeFigure label="mermaid" code={code}>
      <Suspense
        fallback={
          <output
            aria-label={m.markdown_diagram_rendering()}
            className="m-3 block h-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
          />
        }
      >
        <RenderedDiagram code={settled} uiFont={uiFont} />
      </Suspense>
    </CodeFigure>
  )
}

function RenderedDiagram({ code, uiFont }: { code: string; uiFont: Appearance["uiFont"] }) {
  const diagram = useAtomSuspense(diagramAtom(code, uiFont), { includeFailure: true })
  if (AsyncResult.isFailure(diagram)) {
    return (
      <>
        <p className="px-3 pt-2 text-xs text-muted-foreground">{m.markdown_diagram_failed()}</p>
        <pre className="overflow-x-auto p-3 font-mono text-xs">
          <code>{code}</code>
        </pre>
      </>
    )
  }
  return (
    // oxlint-disable-next-line hinacode/no-comments
    // Pele escapes diagram text and filters links and styles: https://pele.run/security
    <div
      className="overflow-x-auto p-3 transition-opacity duration-200 ease-out starting:opacity-0 [&_svg]:mx-auto"
      dangerouslySetInnerHTML={{ __html: diagram.value.svg }}
    />
  )
}
