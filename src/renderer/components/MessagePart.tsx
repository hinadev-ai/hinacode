import type { ReactNode } from "react"
import type { IconType } from "react-icons"
import {
  RiArrowRightSLine,
  RiCheckLine,
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
import { Markdown } from "./Markdown.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"

export function MessagePartView({ part }: { part: MessagePart }) {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} />
    case "reasoning":
      return <ReasoningPart text={part.text} />
    case "tool_call":
      return <ToolCallPart part={part} />
    case "file_change":
      return <FileChangePart path={part.path} diff={part.diff} />
  }
}

const disclosureTrigger =
  "group/trigger flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"

function Chevron() {
  return (
    <RiArrowRightSLine
      aria-hidden
      className="size-3.5 shrink-0 transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
    />
  )
}

function ReasoningPart({ text }: { text: string }) {
  return (
    <Collapsible className="my-1">
      <CollapsibleTrigger className={disclosureTrigger}>
        <Chevron />
        <RiSparkling2Line aria-hidden className="size-3.5 shrink-0" />
        {m.message_reasoning()}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 border-l-2 border-border pl-3 text-xs whitespace-pre-wrap text-muted-foreground">
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
  done: <RiCheckLine aria-hidden className="size-3.5 text-emerald-500" />,
  error: <RiErrorWarningLine aria-hidden className="size-3.5 text-destructive" />,
} satisfies Record<ToolCallStatus, ReactNode>

const statusLabel = {
  running: m.tool_status_running,
  done: m.tool_status_done,
  error: m.tool_status_error,
} satisfies Record<ToolCallStatus, () => string>

function ToolCallPart({ part }: { part: Extract<MessagePart, { type: "tool_call" }> }) {
  const Icon = toolIcons[part.name] ?? RiToolsLine
  const summary = summarizeInput(part.input)

  return (
    <Collapsible className="my-1">
      <CollapsibleTrigger className={disclosureTrigger}>
        <Chevron />
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-foreground">{part.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={summary}>
          {summary}
        </span>
        <span className="shrink-0" title={statusLabel[part.status]()}>
          {statusIcon[part.status]}
          <span className="sr-only">{statusLabel[part.status]()}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-2 pl-7 text-xs">
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
      <h4 className="mb-1 font-medium text-muted-foreground">{label}</h4>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/50 p-2 font-mono whitespace-pre-wrap">
        {text}
      </pre>
    </section>
  )
}

function FileChangePart({ path, diff }: { path: string; diff: string }) {
  const row = (
    <>
      <RiFileEditLine aria-hidden className="size-3.5 shrink-0 text-emerald-500" />
      <span className="shrink-0">{m.file_change_label()}</span>
      <span className="min-w-0 truncate font-mono text-foreground" title={path}>
        {path}
      </span>
    </>
  )
  if (diff === "")
    return <div className="my-1 flex items-center gap-2 px-2 py-1 pl-7.5 text-xs text-muted-foreground">{row}</div>
  return (
    <Collapsible className="my-1">
      <CollapsibleTrigger className={disclosureTrigger}>
        <Chevron />
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 pl-7">
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-xs">
          {diff}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
