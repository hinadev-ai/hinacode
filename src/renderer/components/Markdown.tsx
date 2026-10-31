import { useAtomSuspense } from "@effect/atom-react"
import { cn } from "cn"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { createContext, isValidElement, type ReactNode, Suspense, use, useDeferredValue, useState } from "react"
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import { githubAssetUrl } from "../../shared/channels.ts"
import type { Appearance } from "../../shared/domain.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { imageSource } from "../lib/imageSource.ts"
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

function MarkdownImage({ src, alt }: { src: string | undefined; alt: string }) {
  const environment = useOpenThreadEnvironment()
  const baseUrl = use(BaseUrl)
  const root = use(ThreadFolder)
  return (
    <img
      src={src === undefined ? undefined : imageSource(src, { environment, baseUrl, root })}
      alt={alt}
      loading="lazy"
      className="inline-block max-h-[min(32rem,60vh)] w-auto max-w-[min(100%,40rem)] rounded-md object-contain"
    />
  )
}

const components: Components = {
  p: ({ children, node }) => {
    const asset = bareGitHubAsset(node)
    return asset ? <GitHubAttachment src={asset} /> : <p>{children}</p>
  },
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />,
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
  const rehypePlugins = pattern === null ? [] : [rehypeFindMarks(pattern, part)]
  const repository = useThreadRepository()
  const remarkPlugins = repository ? [remarkGfm, remarkKbd, remarkPullRequests(repository)] : [remarkGfm, remarkKbd]
  return (
    <BaseUrl value={baseUrl}>
      <div className={cn("prose-hina prose max-w-none", className)}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {text}
        </ReactMarkdown>
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
