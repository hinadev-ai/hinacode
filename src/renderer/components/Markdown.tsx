import { cn } from "cn"
import { createContext, isValidElement, type ReactNode, use, useEffect, useState } from "react"
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import { attachmentUrl, githubAssetUrl } from "../../shared/channels.ts"
import type { Appearance } from "../../shared/domain.ts"
import type { EnvironmentId } from "../lib/rpc.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { remarkKbd } from "../lib/remarkKbd.ts"
import { remarkPullRequests } from "../lib/remarkPullRequests.ts"
import { useClientSettings } from "../lib/settings.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { m } from "../paraglide/messages.js"
import { CopyButton } from "./CopyButton.tsx"
import { FindPartContext, rehypeFindMarks, useFindPattern } from "./FindHighlight.tsx"
import { HighlightedCode } from "./HighlightedCode.tsx"
import { isWebUrl, WebLink } from "./WebLink.tsx"

/** The proxied URL when the paragraph is nothing but a bare GitHub attachment link, which GitHub embeds. */
const bareGitHubAsset = (paragraph: ExtraProps["node"]) => {
  const [link, ...rest] = paragraph?.children ?? []
  if (rest.length > 0 || link?.type !== "element" || link.tagName !== "a") return null
  const [text] = link.children
  const href = link.properties["href"]
  return text?.type === "text" && text.value === href ? githubAssetUrl(href) : null
}

/**
 * Agents embed files they saved on this machine, like `vm_screenshot` captures, by absolute path. Markdown
 * percent-encodes the path, as in `Application%20Support`, so it is decoded back first.
 */
const imageSrc = (src: string, environment: EnvironmentId, baseUrl: string | null) => {
  const asset = githubAssetUrl(src)
  if (asset !== null) return asset
  if (src.startsWith("/")) return attachmentUrl(decodeURI(src), environment)
  return baseUrl === null ? src : new URL(src, baseUrl).href
}

const BaseUrl = createContext<string | null>(null)

function MarkdownImage({ src, alt }: { src: string | undefined; alt: string }) {
  const environment = useOpenThreadEnvironment()
  const baseUrl = use(BaseUrl)
  return (
    <img
      src={src === undefined ? undefined : imageSrc(src, environment, baseUrl)}
      alt={alt}
      loading="lazy"
      className="inline-block max-w-full rounded-md"
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
      // target=_blank routes the click through the main process, which opens it in the system browser.
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
  // The scroller takes the table's margin; inside it the margin would no longer collapse with the text around it.
  table: ({ children }) => (
    <div className="my-[2em] overflow-x-auto [&>table]:my-0">
      <table>{children}</table>
    </div>
  ),
}

/** Agent markdown with GFM. `baseUrl` resolves relative image paths, for a file shown from disk. */
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
      <div className={cn("prose prose-sm max-w-none prose-hina", className)}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    </BaseUrl>
  )
}

/** GitHub embeds bare attachment links as video, which is what they usually are; an image falls back to <img>. */
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

/** Pele measures labels in this font to size nodes, so the UI font has to be known before rendering. */
const diagramFont = (uiFont: Appearance["uiFont"]) =>
  uiFont === null
    ? getComputedStyle(document.documentElement).getPropertyValue("--app-font-sans")
    : JSON.stringify(uiFont)

type Diagram =
  | { readonly status: "rendering" }
  | { readonly status: "done"; readonly svg: string }
  | { readonly status: "failed" }

/** Debounce for diagram renders, because streaming grows the source on every delta. */
const RENDER_DELAY_MS = 250

function MermaidDiagram({ code }: { code: string }) {
  const [diagram, setDiagram] = useState<Diagram>({ status: "rendering" })
  const { uiFont } = useClientSettings().appearance

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      // Links and images are off so a diagram an agent wrote cannot make network requests.
      void import("pele/lazy")
        .then(({ renderAsync }) =>
          renderAsync(code, { fontFamily: diagramFont(uiFont), fontSize: 12, links: false, images: false }),
        )
        .then(({ svg }): Diagram => ({ status: "done", svg }))
        .catch((): Diagram => ({ status: "failed" }))
        .then((next) => !cancelled && setDiagram(next))
    }, RENDER_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, uiFont])

  return (
    <CodeFigure label="mermaid" code={code}>
      {diagram.status === "rendering" && (
        <output
          aria-label={m.markdown_diagram_rendering()}
          className="m-3 block h-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
      )}
      {diagram.status === "done" && (
        // Pele escapes diagram text and emits no scripts or event handlers, so its SVG is safe to inject.
        <div
          className="overflow-x-auto p-3 transition-opacity duration-200 ease-out starting:opacity-0 [&_svg]:mx-auto"
          dangerouslySetInnerHTML={{ __html: diagram.svg }}
        />
      )}
      {diagram.status === "failed" && (
        <>
          <p className="px-3 pt-2 text-xs text-muted-foreground">{m.markdown_diagram_failed()}</p>
          <pre className="overflow-x-auto p-3 font-mono text-xs">
            <code>{code}</code>
          </pre>
        </>
      )}
    </CodeFigure>
  )
}
