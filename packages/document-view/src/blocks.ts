import type { CalloutTone } from "../../../src/shared/documentCallout.ts"
import type { BLOCK_KINDS, CONTAINER_KINDS } from "./protocol.ts"

export type BlockKind = (typeof BLOCK_KINDS)[number]
export type ContainerKind = (typeof CONTAINER_KINDS)[number]

export type Run = {
  readonly text: string
  readonly marks: number
  readonly href?: string
  readonly image?: string
  readonly alt?: string
}

export type Container =
  | { readonly kind: "bullet"; readonly first: boolean }
  | { readonly kind: "ordered"; readonly number: number; readonly first: boolean }
  | { readonly kind: "task"; readonly checked: boolean; readonly first: boolean }
  | { readonly kind: "quote"; readonly first: boolean; readonly last: boolean }
  | { readonly kind: "callout"; readonly tone: CalloutTone; readonly first: boolean; readonly last: boolean }

export type CodeToken = readonly [start: number, end: number, color: string]

export type ChartSeries = { readonly label: string; readonly values: ReadonlyArray<number | null> }

export type DiagramRole = "bg" | "fg" | "muted" | "line" | "surface" | "surfaceAlt" | "border" | "accent" | "critical"

export type DiagramPaint = `@${DiagramRole}` | (string & {})

export type DiagramShape =
  | {
      readonly kind: "path"
      readonly data: ReadonlyArray<number>
      readonly fill: DiagramPaint | null
      readonly stroke: DiagramPaint | null
      readonly width: number
      readonly dash: ReadonlyArray<number> | null
      readonly opacity: number
    }
  | {
      readonly kind: "text"
      readonly text: string
      readonly x: number
      readonly y: number
      readonly anchor: "start" | "middle" | "end"
      readonly size: number
      readonly weight: number
      readonly fill: DiagramPaint
    }

export type DiagramDrawing = {
  readonly width: number
  readonly height: number
  readonly shapes: ReadonlyArray<DiagramShape>
}

export type TableAlign = "left" | "center" | "right" | null

export type BlockBody =
  | { readonly kind: "paragraph"; readonly runs: ReadonlyArray<Run> }
  | { readonly kind: "heading"; readonly level: number; readonly runs: ReadonlyArray<Run> }
  | {
      readonly kind: "code"
      readonly language: string
      readonly text: string
      readonly tokens?: ReadonlyArray<CodeToken>
      readonly error?: string
    }
  | {
      readonly kind: "chart"
      readonly type: "bar" | "line"
      readonly title: string
      readonly notes: string
      readonly x: ReadonlyArray<string>
      readonly series: ReadonlyArray<ChartSeries>
      readonly prefix: string
      readonly suffix: string
    }
  | { readonly kind: "diagram"; readonly source: string; readonly drawing?: DiagramDrawing }
  | {
      readonly kind: "table"
      readonly align: ReadonlyArray<TableAlign>
      readonly header: boolean
      readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Run>>>
    }
  | { readonly kind: "image"; readonly src: string; readonly alt: string }
  | { readonly kind: "rule" }
  | { readonly kind: "unsupported"; readonly source: string }

export type RenderBlock = BlockBody & {
  readonly id: string
  readonly containers: ReadonlyArray<Container>
}

export type TextPoint = {
  readonly block: number
  readonly cell: readonly [row: number, column: number] | null
  readonly offset: number
}

export type TextRange = { readonly anchor: TextPoint; readonly head: TextPoint }

export type BlockPatch = {
  readonly revision: number
  readonly eventCount: number
  readonly start: number
  readonly deleteCount: number
  readonly insert: ReadonlyArray<RenderBlock>
  readonly selection?: TextRange
}

export type DocumentTheme = {
  readonly text: string
  readonly muted: string
  readonly link: string
  readonly background: string
  readonly surface: string
  readonly border: string
  readonly codeBackground: string
  readonly codeText: string
  readonly accent: string
  readonly callouts: Readonly<
    Record<CalloutTone, { readonly ink: string; readonly tint: string; readonly label: string }>
  >
  readonly calloutLabels: Readonly<Record<CalloutTone, string>>
  readonly chartLanes: ReadonlyArray<string>
  readonly diagram: Readonly<Record<DiagramRole, string>>
  readonly fontSize: number
  readonly lineHeight: number
  readonly monoFont: string
}
