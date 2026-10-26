import { useParams } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import type { IconType } from "react-icons"
import {
  RiArrowRightSLine,
  RiCheckLine,
  RiContractUpDownLine,
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
import type { Compaction } from "../../shared/agent.ts"
import type { MessagePart, ToolCallStatus } from "../../shared/domain.ts"
import { ansiSegments } from "../lib/ansi.ts"
import { commandFindText, type FindRevealRequest } from "../lib/find.ts"
import { spawnsSubagent, statusOfCall, useOpenSubagent } from "../lib/subagents.ts"
import { countToolKinds, describeCommand, describeToolCall, type ToolKind } from "../lib/toolCall.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useSubagentByCallId } from "../stores/subagents.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { AttachmentView } from "./AttachmentView.tsx"
import { FindPartContext, FindPatternContext, Highlighted } from "./FindHighlight.tsx"
import { HighlightedCode } from "./HighlightedCode.tsx"
import { Markdown } from "./Markdown.tsx"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SubagentStatusIcon } from "./ThreadAgents.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"

export function MessagePartView({ part }: { part: MessagePart }) {
  switch (part.type) {
    case "text":
    case "questions":
      return <Markdown text={part.text} />
    case "reasoning":
      return <ReasoningPart text={part.text} />
    case "tool_call":
      return <ToolCallPart part={part} />
    case "file_change":
      return <FileChangePart path={part.path} diff={part.diff} />
    case "attachment":
      return <AttachmentView attachment={part.attachment} />
    case "compaction":
      return <CompactionPart compaction={part.compaction} />
  }
}

/** How the agent got to its reply recedes, and comes back to full contrast once the user reaches for it. */
const disclosureTrigger =
  "group/trigger -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-panel-open:text-foreground"

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
        {m.message_thinking()}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 border-l-2 border-border pl-3 text-xs whitespace-pre-wrap text-muted-foreground">
        {/* Thinking ends in newlines, which pre-wrap would show as a blank line under the last sentence. */}
        {text.trim()}
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

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

/** Tool results are a string or a list of content blocks; only the text blocks are worth showing. */
export function formatOutput(output: unknown): string {
  if (typeof output === "string") return output
  // Codex wraps an MCP tool's result in `{ content: [...] }`.
  const content = Array.isArray(output) ? output : field(output, "content")
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (field(block, "type") === "image") return m.tool_output_image()
        const text = field(block, "text")
        return typeof text === "string" ? text : JSON.stringify(block)
      })
      .join("\n")
  }
  return JSON.stringify(output, null, 2)
}

const statusIcon = {
  running: <RiLoader4Line aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />,
  done: <RiCheckLine aria-hidden className="size-3.5" />,
  error: <RiErrorWarningLine aria-hidden className="size-3.5 text-destructive" />,
} satisfies Record<ToolCallStatus, ReactNode>

const statusLabel = {
  running: m.tool_status_running,
  done: m.tool_status_done,
  error: m.tool_status_error,
} satisfies Record<ToolCallStatus, () => string>

function ToolCallPart({ part }: { part: Extract<MessagePart, { type: "tool_call" }> }) {
  if (spawnsSubagent(part)) return <SubagentCallPart part={part} />
  const Icon = toolIcons[part.name] ?? RiToolsLine
  const { name, summary } = describeToolCall(part)

  return (
    <Collapsible className="my-1">
      <CollapsibleTrigger className={disclosureTrigger}>
        <Chevron />
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">
          <Highlighted text={name} />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={summary}>
          <Highlighted text={summary} />
        </span>
        <span className="shrink-0" title={statusLabel[part.status]()}>
          {statusIcon[part.status]}
          <span className="sr-only">{statusLabel[part.status]()}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 text-xs">
        <ToolCallDetails call={part} summary={summary} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Inside a tool group the group scrolls, so the details grow to full height instead of scrolling on their own. */
function ToolCallDetails({ call, summary, inGroup = false }: { call: ToolCall; summary: string; inGroup?: boolean }) {
  if (call.name === "Bash") {
    return <CommandView call={call} command={summary} scroll={inGroup ? "" : "max-h-80 overflow-auto"} />
  }
  const scroll = inGroup ? "" : "max-h-64 overflow-auto"
  return (
    <div className="flex flex-col gap-2">
      <ToolSection label={m.tool_input()} text={JSON.stringify(call.input, null, 2)} scroll={scroll} />
      <ToolSection
        label={m.tool_output()}
        text={call.output === undefined ? m.tool_no_output() : formatOutput(call.output)}
        scroll={scroll}
      />
    </div>
  )
}

/**
 * A sub-agent's work lives in its own view, so its row opens that view instead of expanding. A
 * background sub-agent's call returns as soon as it launches, so the row shows the sub-agent's status.
 */
function SubagentCallPart({ part }: { part: Extract<MessagePart, { type: "tool_call" }> }) {
  const { threadId } = useParams({ from: "/thread/$threadId" })
  const provider = useThreads((state) => state.byId[threadId]?.provider)
  const subagent = useSubagentByCallId(threadId, part.callId)
  const open = useOpenSubagent(threadId)
  const { name, summary } = describeToolCall(part)

  return (
    <button type="button" onClick={() => open(part.callId)} className={`my-1 ${disclosureTrigger}`}>
      <span className="size-3.5 shrink-0" />
      {provider ? (
        <ProviderIcon provider={provider} muted />
      ) : (
        <RiToolsLine aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="shrink-0 font-medium">
        <Highlighted text={name} />
      </span>
      <span className="min-w-0 flex-1 truncate" title={summary}>
        <Highlighted text={summary} />
      </span>
      <SubagentStatusIcon status={subagent?.status ?? statusOfCall[part.status]} className="size-3.5" />
      <RiArrowRightSLine aria-hidden className="size-3.5 shrink-0" />
    </button>
  )
}

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export function useFindDisclosure(request: FindRevealRequest | null) {
  const id = request?.id ?? null
  const [open, setOpen] = useState(id !== null)
  const [revealedId, setRevealedId] = useState(id)
  if (id !== revealedId) {
    setRevealedId(id)
    if (id !== null) setOpen(true)
  }
  return [open, setOpen] as const
}

const toolKindLabel = {
  command: m.tool_kind_command,
  read: m.tool_kind_read,
  edit: m.tool_kind_edit,
  search: m.tool_kind_search,
  other: m.tool_kind_other,
} satisfies Record<ToolKind, (inputs: { count: number }) => string>

/** "Ran 2 commands and read 1 file", in the reader's language. */
function summarizeTools(calls: ReadonlyArray<ToolCall>): string {
  const locale = getLocale()
  const summary = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    countToolKinds(calls).map(({ kind, count }) => toolKindLabel[kind]({ count })),
  )
  return summary.charAt(0).toLocaleUpperCase(locale) + summary.slice(1)
}

/**
 * Back-to-back tool calls as one line that opens into a list of them, each opening into its output.
 * `index` is the first call's part index in message `messageId`.
 */
export function ToolGroup({
  messageId,
  index,
  calls,
}: {
  messageId: string
  index: number
  calls: ReadonlyArray<ToolCall>
}) {
  const count = calls.length
  const running = calls.findLast((call) => call.status === "running")
  const failed = calls.filter((call) => call.status === "error").length
  const reveal = useUi((state) => state.findReveal)
  const revealHere =
    reveal !== null &&
    reveal.match.messageId === messageId &&
    reveal.match.partIndex >= index &&
    reveal.match.partIndex < index + count
      ? reveal
      : null
  const [open, setOpen] = useFindDisclosure(revealHere)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1">
      <CollapsibleTrigger className={disclosureTrigger}>
        <Chevron />
        <RiToolsLine aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 shrink truncate font-medium tabular-nums">{summarizeTools(calls)}</span>
        {running && (
          <span className="min-w-0 flex-1 truncate">
            <Highlighted text={describeCommand(running)} />
          </span>
        )}
        {failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-destructive tabular-nums">
            <RiErrorWarningLine aria-hidden className="size-3.5" />
            {m.tool_commands_failed({ count: failed })}
          </span>
        )}
        {running && <span className="ml-auto shrink-0">{statusIcon.running}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-h-96 overflow-y-auto rounded-lg border border-border">
        <ul className="divide-y divide-border">
          {calls.map((call, position) => (
            <li key={call.callId}>
              <FindPartContext value={index + position}>
                <ToolRow call={call} reveal={revealHere?.match.partIndex === index + position ? revealHere : null} />
              </FindPartContext>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A command reads as its command and description. Any other tool reads as its name and summary. */
function ToolRow({ call, reveal }: { call: ToolCall; reveal: FindRevealRequest | null }) {
  const truncate = reveal === null ? "truncate" : "wrap-anywhere"
  const isCommand = call.name === "Bash"
  const { summary } = describeToolCall(call)
  const Icon = toolIcons[call.name] ?? RiToolsLine
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/trigger flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-panel-open:text-foreground">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {isCommand ? <CommandLabel call={call} truncate={truncate} /> : <ToolLabel call={call} truncate={truncate} />}
        <RiArrowRightSLine
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
        />
        {call.status !== "done" && (
          <span className="ml-auto shrink-0" title={statusLabel[call.status]()}>
            {statusIcon[call.status]}
            <span className="sr-only">{statusLabel[call.status]()}</span>
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2 text-xs">
        <ToolCallDetails call={call} summary={summary} inGroup />
      </CollapsibleContent>
    </Collapsible>
  )
}

function CommandLabel({ call, truncate }: { call: ToolCall; truncate: string }) {
  const { distinctLabel, command } = commandFindText(call)
  return (
    <>
      <span className={cn("min-w-0 font-mono", truncate)} title={command}>
        <Highlighted text={command} />
      </span>
      {distinctLabel !== null && (
        <span className={cn("min-w-0 max-w-1/2 shrink-0", truncate)} title={distinctLabel}>
          <Highlighted text={distinctLabel} />
        </span>
      )}
    </>
  )
}

function ToolLabel({ call, truncate }: { call: ToolCall; truncate: string }) {
  const { name, summary } = describeToolCall(call)
  return (
    <>
      <span className="shrink-0 font-medium">
        <Highlighted text={name} />
      </span>
      <span className={cn("min-w-0 font-mono", truncate)} title={summary}>
        <Highlighted text={summary} />
      </span>
    </>
  )
}

/** A shell command as it would read in a terminal: the command, highlighted, then what it printed. */
function CommandView({ call, command, scroll }: { call: ToolCall; command: string; scroll: string }) {
  const output = call.output === undefined ? "" : formatOutput(call.output).replace(/\n$/, "")
  return (
    <div className={cn("rounded-md bg-muted/50 p-2 font-mono", scroll)}>
      <section>
        <h4 className="sr-only">{m.tool_command()}</h4>
        <pre className="whitespace-pre-wrap wrap-anywhere">
          <ShellCode code={command} />
        </pre>
      </section>
      {(output !== "" || call.status !== "running") && (
        <section className="mt-2">
          <h4 className="sr-only">{m.tool_output()}</h4>
          <pre className="ansi-output whitespace-pre-wrap wrap-anywhere text-muted-foreground">
            {output === "" ? m.tool_no_output() : <AnsiText text={output} />}
          </pre>
        </section>
      )}
    </div>
  )
}

function AnsiText({ text }: { text: string }) {
  return ansiSegments(text).map((segment, index) => (
    <span key={index} style={segment.style}>
      {segment.text}
    </span>
  ))
}

/** Unmarked by Find on purpose: the command's row already carries its marks. */
function ShellCode({ code }: { code: string }) {
  return (
    <FindPatternContext value={null}>
      <HighlightedCode code={code} language="shellscript" />
    </FindPatternContext>
  )
}

function ToolSection({ label, text, scroll }: { label: string; text: string; scroll: string }) {
  return (
    <section>
      <h4 className="mb-1 font-medium text-muted-foreground">{label}</h4>
      <pre className={cn("rounded-md bg-muted/50 p-2 font-mono whitespace-pre-wrap wrap-anywhere", scroll)}>{text}</pre>
    </section>
  )
}

function FileChangePart({ path, diff }: { path: string; diff: string }) {
  const row = (
    <>
      <RiFileEditLine aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{m.file_change_label()}</span>
      <span className="min-w-0 truncate font-mono" title={path}>
        <Highlighted text={path} />
      </span>
    </>
  )
  if (diff === "")
    return (
      <div className="my-1 -mx-2 flex items-center gap-2 px-2 py-1 pl-7.5 text-xs text-muted-foreground">{row}</div>
    )
  return (
    <Collapsible className="my-1">
      <CollapsibleTrigger className={disclosureTrigger}>
        <Chevron />
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{diff}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

const formatTokens = (tokens: number) => new Intl.NumberFormat(getLocale(), { notation: "compact" }).format(tokens)

/** A rule across the transcript: what sits above it reaches the agent only as a summary from here on. */
function CompactionPart({ compaction }: { compaction: Compaction }) {
  return (
    <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <CompactionLabel compaction={compaction} />
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

function CompactionLabel({ compaction }: { compaction: Compaction }) {
  switch (compaction.status) {
    case "running":
      return (
        <span className="flex items-center gap-1.5">
          {statusIcon.running}
          {m.compaction_running()}
        </span>
      )
    case "done":
      return (
        <span className="flex items-center gap-1.5">
          <RiContractUpDownLine aria-hidden className="size-3.5 shrink-0" />
          {compaction.trigger === "auto" ? m.compaction_done_auto() : m.compaction_done()}
          {compaction.preTokens !== null && compaction.postTokens !== null && (
            <span className="tabular-nums">
              {m.compaction_tokens({
                before: formatTokens(compaction.preTokens),
                after: formatTokens(compaction.postTokens),
              })}
            </span>
          )}
        </span>
      )
    case "failed":
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <RiErrorWarningLine aria-hidden className="size-3.5 shrink-0 text-destructive" />
          {m.compaction_failed()}
          {compaction.message !== null && <span className="min-w-0 truncate">{compaction.message}</span>}
        </span>
      )
  }
}
