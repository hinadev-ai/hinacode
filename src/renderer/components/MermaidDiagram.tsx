import { useAtomSuspense } from "@effect/atom-react"
import { cn } from "cn"
import { Cause, Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type ReactNode, Suspense, useDeferredValue } from "react"
import type { Appearance } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { familyOf } from "../lib/rpc.ts"
import { useClientSettings } from "../lib/settings.ts"
import { useDebouncedValue } from "../lib/useDebouncedValue.ts"
import { m } from "../paraglide/messages.js"

// FIXME: Pele measures labels in this font to size nodes
const diagramFont = (uiFont: Appearance["uiFont"]) =>
  uiFont === null
    ? getComputedStyle(document.documentElement).getPropertyValue("--app-font-sans")
    : JSON.stringify(uiFont)

const RENDER_DELAY_MS = 250

export const diagramAtom = familyOf((code: string, uiFont: Appearance["uiFont"]) =>
  Atom.make(
    Effect.tryPromise({
      try: () =>
        import("pele/lazy").then(({ renderAsync }) =>
          renderAsync(code, { fontFamily: diagramFont(uiFont), fontSize: 12, links: false, images: false }),
        ),
      catch: (cause) => cause,
    }),
  ),
)

export type DiagramFailure = (message: string, code: string) => ReactNode

export function useSettledDiagram(code: string) {
  const { uiFont } = useClientSettings().appearance
  return { code: useDeferredValue(useDebouncedValue(code, RENDER_DELAY_MS)), uiFont }
}

export function MermaidDiagram({
  code,
  className,
  failed,
}: {
  code: string
  className?: string
  failed: DiagramFailure
}) {
  const settled = useSettledDiagram(code)
  return <DiagramView code={settled.code} uiFont={settled.uiFont} className={className} failed={failed} />
}

export function DiagramView({
  code,
  uiFont,
  className,
  failed,
}: {
  code: string
  uiFont: Appearance["uiFont"]
  className?: string
  failed: DiagramFailure
}) {
  return (
    <Suspense
      fallback={
        <output
          aria-label={m.markdown_diagram_rendering()}
          className="m-3 block h-32 animate-pulse rounded-md bg-foreground/5 motion-reduce:animate-none"
        />
      }
    >
      <RenderedDiagram code={code} uiFont={uiFont} className={className} failed={failed} />
    </Suspense>
  )
}

function RenderedDiagram({
  code,
  uiFont,
  className,
  failed,
}: {
  code: string
  uiFont: Appearance["uiFont"]
  className: string | undefined
  failed: DiagramFailure
}) {
  const diagram = useAtomSuspense(diagramAtom(code, uiFont), { includeFailure: true })
  if (AsyncResult.isFailure(diagram)) return failed(errorMessage(Cause.squash(diagram.cause)), code)
  return (
    // oxlint-disable-next-line hinacode/no-comments
    // Pele escapes diagram text and filters links and styles: https://pele.run/security
    <div
      data-diagram-svg
      className={cn(
        "overflow-x-auto transition-opacity duration-200 ease-out starting:opacity-0 [&_svg]:mx-auto",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: diagram.value.svg }}
    />
  )
}
