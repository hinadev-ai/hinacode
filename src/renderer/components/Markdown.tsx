import type { Mermaid, MermaidConfig } from "mermaid"
import { cn } from "cn"
import { isValidElement, memo, type ReactNode, use, useEffect, useId, useMemo, useState } from "react"
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import { attachmentUrl, githubAssetUrl } from "../../shared/channels.ts"
import type { Appearance } from "../../shared/domain.ts"
import { resolveColor, useTheme } from "../lib/appearance.ts"
import { remarkKbd } from "../lib/remarkKbd.ts"
import { remarkPullRequests } from "../lib/remarkPullRequests.ts"
import { useClientSettings } from "../lib/settings.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { m } from "../paraglide/messages.js"
import { CopyButton } from "./CopyButton.tsx"
import { FindPartContext, Highlighted, rehypeFindMarks, useFindPattern } from "./FindHighlight.tsx"
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
const imageSrc = (src: string) => githubAssetUrl(src) ?? (src.startsWith("/") ? attachmentUrl(decodeURI(src)) : src)

// Spacing, heading scale and block shapes follow the Lettera editor, in em so they scale with the surrounding text.
const block = "my-[0.8em] wrap-break-word first:mt-0 last:mb-0"
const heading = "leading-[1.4] font-medium text-balance first:mt-0"
const list = cn(block, "pl-[2.13em] marker:text-primary [li>&]:my-0")

const components: Components = {
  p: ({ children, node }) => {
    const asset = bareGitHubAsset(node)
    return asset ? <GitHubAttachment src={asset} /> : <p className={block}>{children}</p>
  },
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? imageSrc(src) : undefined}
      alt={alt ?? ""}
      loading="lazy"
      className="inline-block max-w-full rounded-md"
    />
  ),
  a: ({ children, href }) =>
    isWebUrl(href) ? (
      <WebLink href={href}>{children}</WebLink>
    ) : (
      // target=_blank routes the click through the main process, which opens it in the system browser.
      <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
        {children}
      </a>
    ),
  // GFM marks a task list with `contains-task-list`; its checkboxes take the place of the bullets.
  ul: ({ children, className }) => (
    <ul className={cn(list, className === "contains-task-list" ? "list-none" : "list-disc")}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className={cn(list, "list-decimal")}>
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="mb-[0.3em]">{children}</li>,
  input: ({ type, checked }) => (
    <input type={type} checked={checked} disabled className="mr-[0.5em] -ml-[1.5em] translate-y-px accent-primary" />
  ),
  // `className` carries `sr-only` on the heading GFM puts above footnotes.
  h1: ({ children, className }) => (
    <h1 className={cn("mt-[0.8em] mb-[0.33em] text-[2em]", heading, className)}>{children}</h1>
  ),
  h2: ({ children, className }) => (
    <h2 className={cn("mt-[0.66em] mb-[0.27em] text-[1.6em]", heading, className)}>{children}</h2>
  ),
  h3: ({ children, className }) => (
    <h3 className={cn("mt-[0.53em] mb-[0.27em] text-[1.27em]", heading, className)}>{children}</h3>
  ),
  h4: ({ children }) => <h4 className={cn("mt-[0.4em] mb-[0.27em] text-[1.1em]", heading)}>{children}</h4>,
  h5: ({ children }) => <h5 className={cn("mt-[0.4em] mb-[0.27em]", heading)}>{children}</h5>,
  h6: ({ children }) => <h6 className={cn("mt-[0.4em] mb-[0.27em] text-muted-foreground", heading)}>{children}</h6>,
  hr: () => <hr className="my-[1.5em] border-border" />,
  blockquote: ({ children }) => (
    <blockquote
      className={cn(
        block,
        "relative pl-[2.13em] before:absolute before:top-[0.2em] before:left-[1em] before:h-[calc(100%-0.4em)] before:w-[0.13em] before:rounded-full before:bg-primary",
      )}
    >
      {children}
    </blockquote>
  ),
  // A fenced block arrives as <pre><code class="language-x">, so the block is built here and `code` below is only ever inline.
  pre: ({ children }) => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>
    const language = /language-(\S+)/.exec(children.props.className ?? "")?.[1]
    const code = String(children.props.children ?? "").replace(/\n$/, "")
    return language === "mermaid" ? <MermaidDiagram code={code} /> : <CodeBlock language={language} code={code} />
  },
  code: ({ children }) => (
    <code className="rounded-[0.25em] bg-muted px-[0.3em] py-[0.1em] font-mono text-[0.91em]">{children}</code>
  ),
  kbd: ({ children }) => (
    <kbd className="rounded-[0.25em] border border-b-2 border-border bg-muted px-[0.35em] font-mono text-[0.85em]">
      {children}
    </kbd>
  ),
  // Rows are told apart by alternating fills, so only columns get rules.
  table: ({ children }) => (
    <div className={cn(block, "overflow-x-auto rounded-[0.33em] border border-border")}>
      <table className="w-full border-separate border-spacing-0">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
  tr: ({ children }) => <tr className="even:bg-muted">{children}</tr>,
  // GFM column alignment arrives as an inline `text-align`.
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-r border-border px-[0.75em] py-[0.37em] text-left font-semibold last:border-r-0"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-r border-border px-[0.75em] py-[0.37em] align-top last:border-r-0">
      {children}
    </td>
  ),
}

/** Agent markdown with GFM. Memoized because streaming re-renders the message on every delta. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const pattern = useFindPattern()
  const part = use(FindPartContext)
  const rehypePlugins = useMemo(() => (pattern === null ? [] : [rehypeFindMarks(pattern, part)]), [pattern, part])
  const repository = useThreadRepository()
  const remarkPlugins = useMemo(
    () => (repository ? [remarkGfm, remarkKbd, remarkPullRequests(repository)] : [remarkGfm, remarkKbd]),
    [repository],
  )
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {text}
    </ReactMarkdown>
  )
})

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
    <figure className={cn(block, "overflow-hidden rounded-[0.25em] bg-muted")}>
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
          <Highlighted text={code} />
        </code>
      </pre>
    </CodeFigure>
  )
}

let mermaidLoader: Promise<Mermaid> | undefined

/** Mermaid is large, so it loads on the first diagram rather than with the app. */
const loadMermaid = () => (mermaidLoader ??= import("mermaid").then(({ default: mermaid }) => mermaid))

/** Mermaid derives shades from these with its own color math, so they are passed as resolved hex. */
const mermaidConfig = (appearance: Appearance, scheme: "dark" | "light"): MermaidConfig => ({
  startOnLoad: false,
  theme: "base",
  securityLevel: "strict",
  fontFamily:
    appearance.uiFont === null
      ? getComputedStyle(document.documentElement).getPropertyValue("--app-font-sans")
      : JSON.stringify(appearance.uiFont),
  themeVariables: {
    darkMode: scheme === "dark",
    fontSize: "12px",
    primaryColor: resolveColor("--muted"),
    primaryTextColor: resolveColor("--foreground"),
    // Not --border: flattened over the dark background it is darker than the node fill, so a flat stroke vanishes.
    primaryBorderColor: resolveColor("--muted-foreground"),
    lineColor: resolveColor("--muted-foreground"),
    secondaryColor: resolveColor("--muted"),
    tertiaryColor: resolveColor("--card"),
    edgeLabelBackground: resolveColor("--card"),
    // Mermaid 12's base theme draws a gray drop shadow and gradient borders around nodes; the transcript stays flat.
    dropShadow: "none",
    useGradient: false,
  },
})

type Diagram =
  | { readonly status: "rendering" }
  | { readonly status: "done"; readonly svg: string }
  | { readonly status: "failed" }

/** Debounce for diagram renders, because streaming grows the source on every delta. */
const RENDER_DELAY_MS = 250

function MermaidDiagram({ code }: { code: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const [diagram, setDiagram] = useState<Diagram>({ status: "rendering" })
  const { appearance } = useClientSettings()
  const theme = useTheme(appearance.theme)

  useEffect(() => {
    let cancelled = false
    const render = async (): Promise<Diagram> => {
      const mermaid = await loadMermaid()
      mermaid.initialize(mermaidConfig(appearance, theme.scheme))
      // Checking first keeps an invalid source from leaving mermaid's error graphic in the document.
      if (!(await mermaid.parse(code, { suppressErrors: true }))) return { status: "failed" }
      const { svg } = await mermaid.render(id, code)
      return { status: "done", svg }
    }
    const timer = setTimeout(() => {
      void render()
        .catch((): Diagram => ({ status: "failed" }))
        .then((next) => !cancelled && setDiagram(next))
    }, RENDER_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, id, appearance, theme.scheme])

  return (
    <CodeFigure label="mermaid" code={code}>
      {diagram.status === "rendering" && (
        <output
          aria-label={m.markdown_diagram_rendering()}
          className="m-3 block h-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
      )}
      {diagram.status === "done" && (
        // Mermaid sanitizes its own output under securityLevel "strict".
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
