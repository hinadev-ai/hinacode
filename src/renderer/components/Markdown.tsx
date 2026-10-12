import type { Mermaid, MermaidConfig } from "mermaid"
import { isValidElement, memo, type ReactNode, useEffect, useId, useMemo, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Appearance } from "../../shared/domain.ts"
import { resolveColor, useTheme } from "../lib/appearance.ts"
import { remarkPullRequests } from "../lib/remarkPullRequests.ts"
import { useSettings } from "../lib/settings.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { m } from "../paraglide/messages.js"
import { CopyButton } from "./CopyButton.tsx"
import { Highlighted, rehypeFindMarks, useFindPattern } from "./FindHighlight.tsx"
import { isWebUrl, WebLink } from "./WebLink.tsx"

const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) =>
    isWebUrl(href) ? (
      <WebLink href={href}>{children}</WebLink>
    ) : (
      // target=_blank routes the click through the main process, which opens it in the system browser.
      <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
        {children}
      </a>
    ),
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 list-decimal pl-5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  // A fenced block arrives as <pre><code class="language-x">, so the block is built here and `code` below is only ever inline.
  pre: ({ children }) => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>
    const language = /language-(\S+)/.exec(children.props.className ?? "")?.[1]
    const code = String(children.props.children ?? "").replace(/\n$/, "")
    return language === "mermaid" ? <MermaidDiagram code={code} /> : <CodeBlock language={language} code={code} />
  },
  code: ({ children }) => (
    <code className="rounded-sm border border-border bg-muted/60 px-1 py-px font-mono text-[0.85em]">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    <th className="border-l border-border px-2.5 py-1.5 text-left font-medium first:border-l-0">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-t border-l border-border px-2.5 py-1.5 align-top first:border-l-0">{children}</td>
  ),
}

/** Agent markdown with GFM. Memoized because streaming re-renders the message on every delta. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const pattern = useFindPattern()
  const rehypePlugins = useMemo(() => (pattern === null ? [] : [rehypeFindMarks(pattern)]), [pattern])
  const repository = useThreadRepository()
  const remarkPlugins = useMemo(
    () => (repository ? [remarkGfm, remarkPullRequests(repository)] : [remarkGfm]),
    [repository],
  )
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {text}
    </ReactMarkdown>
  )
})

function CodeFigure({ label, code, children }: { label?: string; code: string; children: ReactNode }) {
  return (
    <figure className="my-2 overflow-hidden rounded-lg border border-border bg-muted/50">
      <figcaption className="flex h-9 items-center justify-between border-b border-border pr-1 pl-3">
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
      <pre className="overflow-x-auto p-3 font-mono text-xs">
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
    primaryBorderColor: resolveColor("--border"),
    lineColor: resolveColor("--muted-foreground"),
    secondaryColor: resolveColor("--muted"),
    tertiaryColor: resolveColor("--card"),
    edgeLabelBackground: resolveColor("--card"),
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
  const { appearance } = useSettings()
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
