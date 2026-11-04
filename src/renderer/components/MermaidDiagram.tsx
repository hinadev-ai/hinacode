import { useAtomSuspense } from "@effect/atom-react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, Suspense } from "react"
import type { Appearance } from "../../shared/domain.ts"
import { diagramAtom, useSettledDiagram } from "../lib/diagram.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { m } from "../paraglide/messages.js"

export type DiagramFailure = (message: string, code: string) => ReactNode

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
