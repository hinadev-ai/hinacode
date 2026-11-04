import { isPublishDocumentTool, publishedArtifact, toolArgument } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import { documentOutline, type OutlineBlock } from "../../shared/documentOutline.ts"
import {
  linePath,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  type ThumbnailInk,
  type ThumbnailMark,
  thumbnailMarks,
} from "../../shared/documentThumbnail.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { Highlighted } from "./FindHighlight.tsx"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const SHOWN_SECTIONS = 3

const inkColor = {
  ink: "currentColor",
  chart: "var(--graph-lane-1)",
  note: "var(--graph-lane-1)",
  tip: "var(--graph-lane-2)",
  important: "var(--callout-important)",
  warning: "var(--attention)",
  caution: "var(--destructive)",
} satisfies Record<ThumbnailInk, string>

const stringArgument = (input: unknown, key: string) => {
  const value = toolArgument(input, key)
  return typeof value === "string" && value !== "" ? value : null
}

function ThumbnailMarkView({ mark }: { mark: ThumbnailMark }) {
  const color = inkColor[mark.ink]
  switch (mark.kind) {
    case "rect":
      return (
        <rect
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          rx={mark.radius}
          fill={color}
          fillOpacity={mark.opacity}
        />
      )
    case "outline":
      return (
        <rect
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          rx={mark.radius}
          fill="none"
          stroke={color}
          strokeOpacity={mark.opacity}
          strokeWidth={mark.strokeWidth}
        />
      )
    case "dot":
      return <circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={color} fillOpacity={mark.opacity} />
    case "line":
      return (
        <path
          d={linePath(mark)}
          fill="none"
          stroke={color}
          strokeOpacity={mark.opacity}
          strokeWidth={mark.strokeWidth}
        />
      )
  }
}

function PagePreview({ blocks, publishing }: { blocks: ReadonlyArray<OutlineBlock> | null; publishing: boolean }) {
  return (
    <span
      className={cn(
        "relative block h-18.5 w-14 shrink-0 overflow-clip rounded-md bg-background text-foreground shadow-xs ring-1 ring-foreground/10 transition-[translate,box-shadow] duration-150 ease-out group-hover/card:shadow-md motion-safe:group-hover/card:-translate-y-0.5 dark:bg-foreground/8",
        publishing && "surface-shimmer",
      )}
    >
      <svg aria-hidden viewBox={`0 0 ${THUMBNAIL_WIDTH} ${THUMBNAIL_HEIGHT}`} className="size-full">
        {thumbnailMarks(blocks).map((mark, index) => (
          <ThumbnailMarkView key={index} mark={mark} />
        ))}
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
