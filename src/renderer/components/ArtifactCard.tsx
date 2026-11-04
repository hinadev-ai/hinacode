import type { ReactNode } from "react"
import { isPublishDocumentTool, publishedArtifact, toolArgument } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import type { CalloutTone } from "../../shared/documentCallout.ts"
import { documentOutline, type OutlineBlock } from "../../shared/documentOutline.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { Highlighted } from "./FindHighlight.tsx"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const SHOWN_SECTIONS = 3

const PAGE_WIDTH = 56
const PAGE_HEIGHT = 74
const MARGIN = 7
const TOP = 8
const BOTTOM = PAGE_HEIGHT - 7
const LINE = PAGE_WIDTH - 2 * MARGIN
const GAP = 3

const toneColor = {
  note: "var(--graph-lane-1)",
  tip: "var(--graph-lane-2)",
  important: "var(--callout-important)",
  warning: "var(--attention)",
  caution: "var(--destructive)",
} satisfies Record<CalloutTone, string>

const CHART_BARS = [0.45, 0.65, 0.5, 0.85, 1, 0.7]

const stringArgument = (input: unknown, key: string) => {
  const value = toolArgument(input, key)
  return typeof value === "string" && value !== "" ? value : null
}

const textWeight = (text: string) => [...text].reduce((sum, character) => sum + (character > "⹿" ? 2 : 1), 0)

const between = (min: number, max: number, fraction: number) => min + (max - min) * Math.min(1, Math.max(0, fraction))

const scatter = (seed: number, min: number, max: number) => between(min, max, (seed * 0.618034) % 1)

function Bar({ x = 0, y, width, height = 1.2, opacity, fill = "currentColor" }: BarProps) {
  return <rect x={x} y={y} width={width} height={height} rx={height / 2} fill={fill} fillOpacity={opacity} />
}

type BarProps = {
  readonly x?: number
  readonly y: number
  readonly width: number
  readonly height?: number
  readonly opacity: number
  readonly fill?: string
}

type Shape = { readonly space: number; readonly height: number; readonly marks: ReactNode }

const lastLineWidth = (lines: number, seed: number) =>
  lines === 1 ? LINE * scatter(seed, 0.4, 0.95) : LINE * scatter(seed, 0.35, 0.8)

function blockShape(block: OutlineBlock, index: number): Shape {
  switch (block.kind) {
    case "heading": {
      const weight = textWeight(block.text)
      if (block.level === 1)
        return {
          space: 0,
          height: 3,
          marks: <Bar y={0} width={LINE * between(0.4, 0.9, weight / 40)} height={3} opacity={0.7} />,
        }
      const height = block.level === 2 ? 2.2 : 1.8
      const width = LINE * between(0.3, block.level === 2 ? 0.7 : 0.55, weight / 50)
      return {
        space: 2,
        height,
        marks: <Bar y={0} width={width} height={height} opacity={block.level === 2 ? 0.5 : 0.4} />,
      }
    }
    case "text": {
      const lines = Math.min(3, Math.max(1, Math.ceil(block.length / 80)))
      return {
        space: 0,
        height: (lines - 1) * 3 + 1.2,
        marks: Array.from({ length: lines }, (_, line) => (
          <Bar
            key={line}
            y={line * 3}
            width={line === lines - 1 ? lastLineWidth(lines, block.length) : LINE}
            opacity={0.2}
          />
        )),
      }
    }
    case "list": {
      const rows = Math.min(4, Math.max(1, block.items))
      return {
        space: 0,
        height: (rows - 1) * 3.4 + 1.6,
        marks: Array.from({ length: rows }, (_, row) => (
          <g key={row} transform={`translate(0 ${row * 3.4})`}>
            <circle cx={0.8} cy={0.8} r={0.8} fill="currentColor" fillOpacity={0.35} />
            <Bar x={3} y={0.2} width={(LINE - 3) * scatter(index + row + block.items, 0.45, 0.9)} opacity={0.2} />
          </g>
        )),
      }
    }
    case "tasks": {
      const rows = Math.min(4, Math.max(1, block.total))
      return {
        space: 0,
        height: (rows - 1) * 3.8 + 2.2,
        marks: Array.from({ length: rows }, (_, row) => (
          <g key={row} transform={`translate(0 ${row * 3.8})`}>
            {row < block.done ? (
              <rect width={2.2} height={2.2} rx={0.6} fill="currentColor" fillOpacity={0.45} />
            ) : (
              <rect
                x={0.25}
                y={0.25}
                width={1.7}
                height={1.7}
                rx={0.5}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.4}
                strokeWidth={0.5}
              />
            )}
            <Bar x={4} y={0.5} width={(LINE - 4) * scatter(index + row + block.total, 0.4, 0.85)} opacity={0.2} />
          </g>
        )),
      }
    }
    case "table": {
      const columns = Math.min(4, Math.max(1, block.columns))
      const rows = Math.min(4, Math.max(1, block.rows)) + 1
      const row = 3
      return {
        space: 0,
        height: rows * row,
        marks: (
          <>
            <rect width={LINE} height={row} rx={1} fill="currentColor" fillOpacity={0.1} />
            {Array.from({ length: rows }, (_, line) => (
              <rect
                key={`r${line}`}
                y={(line + 1) * row - 0.4}
                width={LINE}
                height={0.4}
                fill="currentColor"
                fillOpacity={0.14}
              />
            ))}
            {Array.from({ length: columns - 1 }, (_, line) => (
              <rect
                key={`c${line}`}
                x={((line + 1) * LINE) / columns}
                width={0.4}
                height={rows * row}
                fill="currentColor"
                fillOpacity={0.14}
              />
            ))}
          </>
        ),
      }
    }
    case "code":
      return {
        space: 0,
        height: 8,
        marks: (
          <>
            <rect width={LINE} height={8} rx={1.5} fill="currentColor" fillOpacity={0.07} />
            <Bar x={2.5} y={2.2} width={LINE * scatter(index, 0.3, 0.55)} height={1} opacity={0.25} />
            <Bar x={2.5} y={4.8} width={LINE * scatter(index + 1, 0.45, 0.75)} height={1} opacity={0.25} />
          </>
        ),
      }
    case "chart":
      return {
        space: 0,
        height: 10,
        marks: (
          <>
            {CHART_BARS.map((share, bar) => (
              <rect
                key={bar}
                x={1 + bar * 5}
                y={9.4 - share * 9}
                width={3.4}
                height={share * 9}
                rx={0.6}
                fill="var(--graph-lane-1)"
                fillOpacity={0.75}
              />
            ))}
            <rect y={9.6} width={LINE} height={0.4} fill="currentColor" fillOpacity={0.2} />
          </>
        ),
      }
    case "diagram": {
      const box = 9
      const middle = (LINE - box) / 2
      return {
        space: 0,
        height: 5,
        marks: (
          <g fill="none" stroke="currentColor" strokeOpacity={0.4} strokeWidth={0.6}>
            {[0, middle, LINE - box].map((x) => (
              <rect key={x} x={x + 0.3} y={0.3} width={box - 0.6} height={4.4} rx={1} />
            ))}
            <path d={`M${box} 2.5H${middle}M${middle + box} 2.5H${LINE - box}`} />
          </g>
        ),
      }
    }
    case "callout": {
      const color = toneColor[block.tone]
      return {
        space: 0,
        height: 7.5,
        marks: (
          <>
            <rect width={LINE} height={7.5} rx={1.5} fill={color} fillOpacity={0.14} />
            <Bar x={2.5} y={2} width={LINE - 5} height={1.1} opacity={0.55} fill={color} />
            <Bar x={2.5} y={4.4} width={(LINE - 5) * 0.55} height={1.1} opacity={0.55} fill={color} />
          </>
        ),
      }
    }
  }
}

function OutlineMarks({ blocks }: { blocks: ReadonlyArray<OutlineBlock> }) {
  const drawn: Array<ReactNode> = []
  let y = TOP
  for (const [index, block] of blocks.entries()) {
    const { space, height, marks } = blockShape(block, index)
    const top = index === 0 ? y : y + space
    if (top + height > BOTTOM) break
    drawn.push(
      <g key={index} transform={`translate(${MARGIN} ${top})`}>
        {marks}
      </g>,
    )
    y = top + height + GAP
  }
  return drawn
}

const PAGE_WIREFRAME = (
  <g transform={`translate(${MARGIN} ${TOP})`}>
    <Bar y={0} width={8} height={1.6} opacity={0.45} />
    {[0, 1, 2].map((link) => (
      <Bar key={link} x={LINE - 15 + link * 5.5} y={0.2} width={3.5} height={1.2} opacity={0.2} />
    ))}
    <Bar y={7} width={LINE * 0.7} height={3} opacity={0.7} />
    <Bar y={13} width={LINE} opacity={0.2} />
    <Bar y={16} width={LINE * 0.6} opacity={0.2} />
    <rect y={21} width={LINE} height={14} rx={1.5} fill="currentColor" fillOpacity={0.07} />
    {[0, 1, 2].map((card) => (
      <rect
        key={card}
        x={card * ((LINE + 2) / 3)}
        y={38}
        width={(LINE - 4) / 3}
        height={10}
        rx={1}
        fill="currentColor"
        fillOpacity={0.07}
      />
    ))}
    <Bar y={52} width={LINE} opacity={0.2} />
    <Bar y={55} width={LINE * 0.45} opacity={0.2} />
  </g>
)

function PagePreview({ blocks, publishing }: { blocks: ReadonlyArray<OutlineBlock> | null; publishing: boolean }) {
  return (
    <span
      className={cn(
        "relative block h-18.5 w-14 shrink-0 overflow-clip rounded-md bg-background text-foreground shadow-xs ring-1 ring-foreground/10 transition-[translate,box-shadow] duration-150 ease-out group-hover/card:shadow-md motion-safe:group-hover/card:-translate-y-0.5 dark:bg-foreground/8",
        publishing && "surface-shimmer",
      )}
    >
      <svg aria-hidden viewBox={`0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}`} className="size-full">
        {blocks === null ? PAGE_WIREFRAME : <OutlineMarks blocks={blocks} />}
      </svg>
    </span>
  )
}

const sectionsLine = (blocks: ReadonlyArray<OutlineBlock>) => {
  const sections = blocks.flatMap((block) =>
    block.kind === "heading" && block.level === 2 && block.text !== "" ? [block.text] : [],
  )
  if (sections.length === 0) return null
  const listed = new Intl.ListFormat(getLocale(), { type: "conjunction", style: "narrow" }).format(
    sections.slice(0, SHOWN_SECTIONS),
  )
  const more = sections.length - SHOWN_SECTIONS
  return more > 0 ? m.artifact_card_more_sections({ sections: listed, count: more }) : listed
}

export function ArtifactCard({
  call,
  result,
  onOpen,
}: {
  call: ToolCall
  result: string | null
  onOpen: (id: string | null) => void
}) {
  const isDocument = isPublishDocumentTool(call.name)
  const markdown = isDocument ? stringArgument(call.input, "markdown") : null
  const outline = markdown === null ? null : documentOutline(markdown)
  const published = result === null ? null : publishedArtifact(result)
  const untitled = isDocument ? m.documents_untitled() : m.artifact_untitled()
  const title = stringArgument(call.input, "title") ?? outline?.title ?? untitled
  const publishing = call.status === "running"
  const summary = outline === null ? null : (outline.lede ?? sectionsLine(outline.blocks))

  return (
    <button
      type="button"
      onClick={() => onOpen(published?.id ?? null)}
      aria-label={m.artifact_open({ title })}
      className="group/card my-2 flex w-full max-w-md min-w-0 items-center gap-3.5 rounded-xl bg-muted/50 p-2.5 pe-4 text-start pressable outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PagePreview blocks={isDocument ? (outline?.blocks ?? []) : null} publishing={publishing} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span>{isDocument ? m.artifact_card_document() : m.artifact_card_page()}</span>
          {(publishing || published !== null) && <span aria-hidden>·</span>}
          {publishing ? (
            <span className="text-shimmer">{m.artifact_card_publishing()}</span>
          ) : (
            published !== null && (
              <span className="tabular-nums">{m.artifacts_version({ version: published.version })}</span>
            )
          )}
        </span>
        <span dir="auto" className="truncate text-sm font-medium" title={title}>
          <Highlighted text={title} />
        </span>
        {summary !== null && (
          <span dir="auto" className="line-clamp-2 text-xs/relaxed text-pretty text-muted-foreground">
            {summary}
          </span>
        )}
      </span>
    </button>
  )
}
