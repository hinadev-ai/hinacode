import type { ReactNode } from "react"
import type { IconType } from "react-icons"
import {
  RiArrowRightSLine,
  RiEditLine,
  RiErrorWarningLine,
  RiFileEditLine,
  RiFileTextLine,
  RiGlobalLine,
  RiLoader4Line,
  RiSearchLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
  RiToolsLine,
} from "react-icons/ri"
import type { MessagePart, ToolCallStatus } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { AttachmentView } from "./AttachmentView.tsx"
import { Markdown } from "./Markdown.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"

export function MessagePartView({ part }: { part: MessagePart }) {
  switch (part.type) {
    case "text":
      return (
        <div className="my-3 first:mt-0 last:mb-0">
          <Markdown text={part.text} />
        </div>
      )
    case "reasoning":
      return <ReasoningPart text={part.text} />
    case "tool_call":
      return <ToolCallPart part={part} />
    case "file_change":
      return <FileChangePart path={part.path} diff={part.diff} />
    case "attachment":
      return <AttachmentView attachment={part.attachment} />
  }
}

const disclosureTrigger =
  "group/trigger -mx-2 flex h-7 w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

const disclosureContent = "mt-1 mb-2 ml-[7px] border-l border-border pl-[15px]"

/** The row's icon gives way to a chevron on hover and while open, so the row reads as expandable only when it matters. */
function RowIcon({ icon: Icon }: { icon: IconType }) {
  return (
    <span aria-hidden className="relative size-3.5 shrink-0">
      <Icon className="absolute inset-0 size-3.5 transition-opacity duration-100 group-hover/trigger:opacity-0 group-focus-visible/trigger:opacity-0 group-data-panel-open/trigger:opacity-0" />
      <RiArrowRightSLine className="absolute inset-0 size-3.5 opacity-0 transition-[opacity,rotate] duration-150 group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100 group-data-panel-open/trigger:rotate-90 group-data-panel-open/trigger:opacity-100 motion-reduce:transition-none" />
    </span>
  )
}

function ReasoningPart({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className={disclosureTrigger}>
        <RowIcon icon={RiSparkling2Line} />
        {m.message_reasoning()}
      </CollapsibleTrigger>
      <CollapsibleContent className={`${disclosureContent} text-xs/relaxed whitespace-pre-wrap text-muted-foreground`}>
        {text}
      </CollapsibleContent>
    </Collapsible>
  )
}

const toolIcons: Record<string, IconType> = {
  Bash: RiTerminalBoxLine,
  Read: RiFileTextLine,
  Edit: RiEditLine,
  MultiEdit: RiEditLine,
  Write: RiEditLine,
  NotebookEdit: RiEditLine,
  Glob: RiSearchLine,
  Grep: RiSearchLine,
  WebFetch: RiGlobalLine,
  WebSearch: RiGlobalLine,
}

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"]

/** The one input field that best says what a tool call does, for the collapsed row. */
function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  for (const key of SUMMARY_KEYS) {
    const value: unknown = Reflect.get(input, key)
    if (typeof value === "string") return value
  }
  return JSON.stringify(input)
}

/** Tool results are a string or a list of content blocks; only the text blocks are worth showing. */
function formatOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (Array.isArray(output)) {
    return output
      .map((block: unknown) => {
        const text: unknown = typeof block === "object" && block !== null ? Reflect.get(block, "text") : undefined
        return typeof text === "string" ? text : JSON.stringify(block)
      })
      .join("\n")
  }
  return JSON.stringify(output, null, 2)
}

const statusIcon = {
  running: <RiLoader4Line aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />,
  done: null,
  error: <RiErrorWarningLine aria-hidden className="size-3.5 text-destructive" />,
} satisfies Record<ToolCallStatus, ReactNode>

const statusLabel = {
  running: m.tool_status_running,
  done: m.tool_status_done,
  error: m.tool_status_error,
} satisfies Record<ToolCallStatus, () => string>

function ToolCallPart({ part }: { part: Extract<MessagePart, { type: "tool_call" }> }) {
  const summary = summarizeInput(part.input)

  return (
    <Collapsible>
      <CollapsibleTrigger className={disclosureTrigger}>
        <RowIcon icon={toolIcons[part.name] ?? RiToolsLine} />
        <span className="shrink-0 font-medium text-foreground/90">{part.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={summary}>
          {summary}
        </span>
        <span className="shrink-0" title={statusLabel[part.status]()}>
          {statusIcon[part.status]}
          <span className="sr-only">{statusLabel[part.status]()}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={`${disclosureContent} flex flex-col gap-3 text-xs`}>
        <ToolSection label={m.tool_input()} text={JSON.stringify(part.input, null, 2)} />
        <ToolSection
          label={m.tool_output()}
          text={part.output === undefined ? m.tool_no_output() : formatOutput(part.output)}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolSection({ label, text }: { label: string; text: string }) {
  return (
    <section>
      <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">{label}</h4>
      <pre className="max-h-64 overflow-auto rounded-md bg-canvas/60 p-2.5 font-mono text-[11px]/relaxed whitespace-pre-wrap text-foreground/85">
        {text}
      </pre>
    </section>
  )
}

/** Added and removed line counts of a unified diff, ignoring the `+++`/`---` file headers. */
const countLines = (diff: string) => {
  let added = 0
  let removed = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

const diffLineTone = (line: string) => {
  if (line.startsWith("+") && !line.startsWith("+++")) return "bg-success/10 text-success"
  if (line.startsWith("-") && !line.startsWith("---")) return "bg-destructive/10 text-destructive"
  if (line.startsWith("@@")) return "text-muted-foreground"
  return "text-foreground/80"
}

function FileChangePart({ path, diff }: { path: string; diff: string }) {
  const { added, removed } = countLines(diff)
  const row = (
    <>
      <span className="shrink-0">{m.file_change_label()}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-foreground/90" title={path}>
        {path}
      </span>
      {diff !== "" && (
        <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
          <span className="text-success">+{added}</span>
          <span className="text-destructive">−{removed}</span>
        </span>
      )}
    </>
  )
  if (diff === "")
    return (
      <div className="flex h-7 items-center gap-2 text-xs text-muted-foreground">
        <RiFileEditLine aria-hidden className="size-3.5 shrink-0" />
        {row}
      </div>
    )
  return (
    <Collapsible>
      <CollapsibleTrigger className={disclosureTrigger}>
        <RowIcon icon={RiFileEditLine} />
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent className={disclosureContent}>
        <pre className="max-h-80 overflow-auto rounded-md bg-canvas/60 py-2 font-mono text-[11px]/relaxed">
          <div className="w-max min-w-full">
            {diff.trimEnd().split("\n").map((line, index) => (
              // Lines of a finished diff never move, so the index is a stable key.
              <div key={index} className={`px-2.5 ${diffLineTone(line)}`}>
                {line || " "}
              </div>
            ))}
          </div>
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
