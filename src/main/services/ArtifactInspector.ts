import { Context, Effect, Layer } from "effect"
import type { ArtifactTheme } from "../../shared/artifactTheme.ts"

export const INSPECTION_VIEWPORT = { width: 400, height: 720 } as const

export interface ArtifactInspection {
  readonly errors: ReadonlyArray<string>
  readonly pageWidth: number
  readonly pastTheEdge: ReadonlyArray<string>
  readonly screenshot: { readonly data: Uint8Array; readonly mimeType: string }
}

export class ArtifactInspector extends Context.Service<
  ArtifactInspector,
  {
    readonly setTheme: (theme: ArtifactTheme) => Effect.Effect<void>
    readonly inspect: (id: string, entry: string) => Effect.Effect<ArtifactInspection | null>
  }
>()("hinacode/ArtifactInspector") {}

export type InspectPage = (id: string, entry: string, theme: ArtifactTheme | undefined) => Promise<ArtifactInspection>

export const layerWith = (inspectPage: InspectPage) =>
  Layer.sync(ArtifactInspector, () => {
    let theme: ArtifactTheme | undefined
    return ArtifactInspector.of({
      setTheme: (next) =>
        Effect.sync(() => {
          theme = next
        }),
      inspect: (id, entry) =>
        Effect.tryPromise(() => inspectPage(id, entry, theme)).pipe(
          Effect.catch((cause) => Effect.as(Effect.logWarning("could not inspect artifact", id, cause), null)),
        ),
    })
  })

export const unavailable = Layer.succeed(
  ArtifactInspector,
  ArtifactInspector.of({ setTheme: () => Effect.void, inspect: () => Effect.succeed(null) }),
)

const bullet = (line: string) => `- ${line}`

export const describeInspection = ({ errors, pageWidth, pastTheEdge }: ArtifactInspection) => {
  const { width } = INSPECTION_VIEWPORT
  const findings = [
    ...(errors.length === 0 ? [] : [`Console errors:\n${errors.map((error) => `  ${bullet(error)}`).join("\n")}`]),
    ...(pageWidth <= width
      ? []
      : [
          `The page is ${pageWidth}px wide and scrolls sideways in a ${width}px panel.${pastTheEdge.length === 0 ? "" : ` Past the edge: ${pastTheEdge.join(", ")}.`}`,
        ]),
  ]
  const summary =
    findings.length === 0
      ? `Rendered at ${width}px, the side panel's usual width: no console errors and no sideways scroll.`
      : `Rendered at ${width}px, the side panel's usual width. Fix these and publish again:\n${findings.map(bullet).join("\n")}`
  return `${summary}\nThe screenshot shows the top of the page as the developer first sees it.`
}
