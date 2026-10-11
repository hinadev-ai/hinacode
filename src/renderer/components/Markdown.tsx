import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

const remarkPlugins = [remarkGfm]

const components: Components = {
  p: ({ children }) => <p className="my-3 text-pretty first:mt-0 last:mb-0">{children}</p>,
  // target=_blank routes the click through the main process, which opens it in the system browser.
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline decoration-foreground/30 underline-offset-[3px] transition-colors hover:decoration-foreground"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-3 list-disc pl-5 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-3 list-decimal pl-5 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-1 pl-1">{children}</li>,
  h1: ({ children }) => <h1 className="mt-6 mb-2 text-base font-semibold tracking-tight first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-prose font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1 text-prose font-medium first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-canvas/60 px-4 py-3 font-mono text-xs/relaxed">
      {children}
    </pre>
  ),
  code: ({ children, className }) =>
    // Fenced blocks carry a language class and sit inside <pre>, which already styles them.
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-[4px] bg-accent px-[0.3em] py-[0.1em] font-mono text-[0.85em]">{children}</code>
    ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-muted px-3 py-1.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-3 py-1.5 [tr:last-child_&]:border-b-0">{children}</td>,
}

/** Agent markdown with GFM. Memoized because streaming re-renders the message on every delta. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {text}
    </ReactMarkdown>
  )
})
