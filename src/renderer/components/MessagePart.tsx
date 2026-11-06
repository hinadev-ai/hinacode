import { todosInCall } from "../../shared/todos.ts"
import { TodoRow } from "./TodoActivity.tsx"
import { RiGitPullRequestLine, RiSendToBack } from "react-icons/ri"
import { Link, useParams } from "@tanstack/react-router"
import { createContext, type ReactNode, use, useId, useState } from "react"
import { toast } from "sonner"
import {
  type AccountProviderId,
  type Compaction,
  createdThreadId,
  type ProviderId,
  toolArgument,
} from "../../shared/agent.ts"
import {
  type Message,
  type MessagePart,
  createsThread,
  publishesArtifact,
  spawnsSubagent,
  type Thread,
  type ToolCallStatus,
} from "../../shared/domain.ts"
import { ansiSegments } from "../lib/ansi.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { commandFindText, type FindRevealRequest } from "../lib/find.ts"
import { statusOfCall } from "../../shared/subagents.ts"
import { useOpenSubagent } from "../lib/subagents.ts"
import { callPromise } from "../lib/rpc.ts"
import {
  type ActivityPart,
  conjunctionFormat,
  countToolKinds,
  describeCommand,
  describeToolCall,
  ownToolName,
  toolOutputImages,
  type SkillLabels as SkillLabelMap,
  skillsUsed,
  skillUseText,
  type ToolKind,
} from "../lib/toolCall.ts"
import { decodeUnicodeEscapes } from "../lib/unicodeEscapes.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { openArtifact } from "../stores/artifacts.ts"
import { useSubagentByCallId } from "../stores/subagents.ts"
import { providerInfo } from "../../shared/providers.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { ArtifactCard } from "./ArtifactCard.tsx"
import { AttachmentView, formatBytes } from "./AttachmentView.tsx"
import { CopyButton } from "./CopyButton.tsx"
import { FindPartContext, FindPatternContext, Highlighted } from "./FindHighlight.tsx"
import { HighlightedCode } from "./HighlightedCode.tsx"
import { Markdown } from "./Markdown.tsx"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { StatusIndicator, useThreadRowState } from "./SidebarThreadList.tsx"
import { SubagentStatusIcon } from "./ThreadAgents.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import {
  BrainIcon,
  ChatNewIcon,
  CheckIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CollapseIcon,
  FileDiffIcon,
  FileTextIcon,
  LayoutIcon,
  GlobeIcon,
  type IconComponent,
  PencilIcon,
  SearchIcon,
  SkillIcon,
  SpinnerIcon,
  TerminalIcon,
  ToolsIcon,
  WarningIcon,
} from "@hinacode/icons"

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
    case "agent_switch":
      return <AgentSwitchPart from={part.from} to={part.to} />
    case "session_import":
      return <SessionImportPart provider={part.provider} history={part.history} />
    case "signed_out":
      return <SignedOutPart message={part.message} loginCommand={part.loginCommand} />
  }
}

const disclosureTrigger =
  "group/trigger flex w-fit max-w-full min-w-0 items-center gap-2 rounded-sm py-0.5 text-left text-sm text-receding-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

function Chevron() {
  return (
    <ChevronRightIcon
      aria-hidden
      className="size-3.5 shrink-0 opacity-0 transition-[rotate,opacity] group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100 group-data-panel-open/trigger:rotate-90 group-data-panel-open/trigger:opacity-100 motion-reduce:transition-none"
    />
  )
}

function ReasoningPart({ text, className = "my-2" }: { text: string; className?: string }) {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger className={disclosureTrigger}>
        <BrainIcon aria-hidden className="size-4 shrink-0" />
        {m.message_thinking()}
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {text.trim()}
      </CollapsibleContent>
    </Collapsible>
  )
}

const toolIcons: Record<string, IconComponent> = {
  Bash: TerminalIcon,
  Read: FileTextIcon,
  Edit: PencilIcon,
  MultiEdit: PencilIcon,
  Write: PencilIcon,
  NotebookEdit: PencilIcon,
  Glob: SearchIcon,
  Grep: SearchIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  TodoWrite: CheckCircleIcon,
  write_todos: CheckCircleIcon,
  update_plan: CheckCircleIcon,
  TaskCreate: CheckCircleIcon,
  TaskUpdate: CheckCircleIcon,
  link_pull_request: RiGitPullRequestLine,
  list_thread_pull_requests: RiGitPullRequestLine,
  unlink_pull_request: RiGitPullRequestLine,
  watch_pull_request: RiGitPullRequestLine,
  unwatch_pull_request: RiGitPullRequestLine,
  publish_artifact: LayoutIcon,
  list_artifacts: LayoutIcon,
  read_artifact: LayoutIcon,
  publish_document: FileTextIcon,
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

export function formatOutput(output: unknown): string {
  if (typeof output === "string") return decodeUnicodeEscapes(output)
  // FIXME: Codex wraps an MCP tool's result in `{ content: [...] }`
  const content = Array.isArray(output) ? output : field(output, "content")
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (field(block, "type") === "image") return m.tool_output_image()
        const text = field(block, "text")
        return typeof text === "string" ? decodeUnicodeEscapes(text) : JSON.stringify(block)
      })
      .join("\n")
  }
  return JSON.stringify(output, null, 2)
}

const statusIcon = {
  running: <SpinnerIcon aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />,
  done: <CheckIcon aria-hidden className="size-3.5" />,
  error: <WarningIcon aria-hidden className="size-3.5 text-destructive" />,
} satisfies Record<ToolCallStatus, ReactNode>

const statusLabel = {
  running: m.tool_status_running,
  done: m.tool_status_done,
  error: m.tool_status_error,
} satisfies Record<ToolCallStatus, () => string>

export const SubagentLinks = createContext(true)

export const PartMessage = createContext<Pick<Message, "id" | "threadId">>({ id: "", threadId: "" })

export const SkillLabels = createContext<SkillLabelMap>(new Map())

function ToolCallPart({ part }: { part: Extract<MessagePart, { type: "tool_call" }> }) {
  const linksSubagents = use(SubagentLinks)
  if (linksSubagents && spawnsSubagent(part)) return <SubagentCallPart part={part} />
  if (publishesArtifact(part)) return <ArtifactCallPart part={part} />
  if (createsThread(part)) return <ThreadCallPart part={part} />
  return (
    <div className="my-2">
      <ToolRow call={part} reveal={null} />
    </div>
  )
}

function ToolCallDetails({
  call: shipped,
  summary,
  inGroup = false,
}: {
  call: ToolCall
  summary: string
  inGroup?: boolean
}) {
  const [call, showFullOutput] = useFullOutput(shipped)
  const todos = todosInCall(call)
  if (todos !== null) {
    return (
      <ul className="flex flex-col gap-1 pl-6">
        {todos.map((todo, index) => (
          <TodoRow key={`${index}-${todo.text}`} todo={todo} />
        ))}
      </ul>
    )
  }
  const fullOutputButton = call.fullOutputBytes !== undefined && (
    <Button variant="link" size="xs" action={showFullOutput} className="-ml-2 font-sans text-muted-foreground">
      {m.tool_output_show_full({ size: formatBytes(call.fullOutputBytes) })}
    </Button>
  )
  if (call.name === "Bash") {
    return (
      <CommandView
        call={call}
        command={summary}
        scroll={inGroup ? "" : "max-h-80 overflow-auto"}
        fullOutputButton={fullOutputButton}
      />
    )
  }
  const scroll = inGroup ? "" : "max-h-64 overflow-auto"
  return (
    <div className="flex flex-col gap-2">
      <ToolSection label={m.tool_input()} text={JSON.stringify(call.input, null, 2)} scroll={scroll} />
      <ToolSection
        label={m.tool_output()}
        text={call.output === undefined ? m.tool_no_output() : formatOutput(call.output)}
        scroll={scroll}
        fullOutputButton={fullOutputButton}
      />
    </div>
  )
}

function useFullOutput(shipped: ToolCall) {
  const message = use(PartMessage)
  const [full, setFull] = useState<ToolCall | null>(null)
  const showFullOutput = async () => {
    try {
      const output = await callPromise("threads.toolOutput", {
        threadId: message.threadId,
        messageId: message.id,
        callId: shipped.callId,
      })
      const { fullOutputBytes: _fullOutputBytes, ...call } = shipped
      setFull({ ...call, output })
    } catch (cause) {
      toast.error(m.tool_output_load_failed({ message: errorMessage(cause) }))
    }
  }
  return [full ?? shipped, showFullOutput] as const
}

function SubagentCallPart({ part }: { part: Extract<MessagePart, { type: "tool_call" }> }) {
  const { threadId } = useParams({ from: "/thread/$threadId" })
  const threadProvider = useThreads((state) => state.byId[threadId]?.provider)
  const subagent = useSubagentByCallId(threadId, part.callId)
  const provider = subagent?.provider ?? threadProvider
  const open = useOpenSubagent(threadId)
  const { name, summary } = describeToolCall(part)

  return (
    <button type="button" onClick={() => open(part.callId)} className={`my-2 ${disclosureTrigger}`}>
      {provider ? (
        <ProviderIcon provider={provider} muted className="text-current" />
      ) : (
        <ToolsIcon aria-hidden className="size-4 shrink-0" />
      )}
      <span className="shrink-0">
        <Highlighted text={name} />
      </span>
      <span className="min-w-0 truncate" title={summary}>
        <Highlighted text={summary} />
      </span>
      <SubagentStatusIcon status={subagent?.status ?? statusOfCall[part.status]} className="size-3.5" />
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
    </button>
  )
}

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

function ArtifactCallPart({ part }: { part: ToolCall }) {
  const { threadId } = use(PartMessage)
  return (
    <ArtifactCard
      call={part}
      result={part.output === undefined ? null : formatOutput(part.output)}
      onOpen={(id) => openArtifact(threadId, id)}
    />
  )
}

const threadCard = "my-2 flex w-full max-w-sm min-w-0 items-center gap-3 rounded-lg border border-border px-3 py-2.5"

function ThreadCallPart({ part }: { part: ToolCall }) {
  const threadId = part.output === undefined ? null : createdThreadId(formatOutput(part.output))
  const thread = useThreads((state) => (threadId === null ? undefined : state.byId[threadId]))
  if (thread !== undefined) return <ThreadCard thread={thread} />
  const title = toolArgument(part.input, "title")
  return (
    <div className={cn(threadCard, "text-muted-foreground")}>
      <ChatNewIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">
        <Highlighted text={typeof title === "string" ? title : ""} />
      </span>
      {part.status === "running" && statusIcon.running}
    </div>
  )
}

function ThreadCard({ thread }: { thread: Thread }) {
  const state = useThreadRowState(thread)
  return (
    <Link
      to="/thread/$threadId"
      params={{ threadId: thread.id }}
      aria-label={m.thread_card_open({ title: thread.title })}
      className={cn(
        threadCard,
        "bg-background/50 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <ProviderIcon provider={thread.provider} muted />
      <span className="min-w-0 flex-1 truncate text-sm">
        <Highlighted text={thread.title} />
      </span>
      <StatusIndicator state={state} />
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
    </Link>
  )
}

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
  skill: m.tool_kind_skill,
  other: m.tool_kind_other,
} satisfies Record<ToolKind, (inputs: { count: number }) => string>

function summarizeTools(calls: ReadonlyArray<ToolCall>): string {
  const locale = getLocale()
  const summary = conjunctionFormat(locale).format(
    countToolKinds(calls).map(({ kind, count }) => toolKindLabel[kind]({ count })),
  )
  return summary.charAt(0).toLocaleUpperCase(locale) + summary.slice(1)
}

export function ToolGroup({
  messageId,
  index,
  parts,
}: {
  messageId: string
  index: number
  parts: ReadonlyArray<ActivityPart>
}) {
  const calls = parts.filter((part) => part.type === "tool_call")
  const count = parts.length
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

  const rows = (
    <ul className="flex flex-col gap-1">
      {parts.map((part, position) => (
        <li key={part.type === "tool_call" ? part.callId : position}>
          <FindPartContext value={index + position}>
            {part.type === "tool_call" ? (
              <ToolRow call={part} reveal={revealHere?.match.partIndex === index + position ? revealHere : null} />
            ) : (
              <ReasoningPart text={part.text} className="" />
            )}
          </FindPartContext>
        </li>
      ))}
    </ul>
  )
  if (calls.length === 1) return <div className="my-2">{rows}</div>
  const Icon = toolIcons[ownToolName(calls[0]?.name ?? "")] ?? ToolsIcon

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2">
      <CollapsibleTrigger className={disclosureTrigger}>
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 shrink truncate tabular-nums">{summarizeTools(calls)}</span>
        {running && (
          <span className="min-w-0 truncate">
            <Highlighted text={describeCommand(running)} />
          </span>
        )}
        {failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-destructive tabular-nums">
            <WarningIcon aria-hidden className="size-3.5" />
            {m.tool_commands_failed({ count: failed })}
          </span>
        )}
        {running && <span className="shrink-0">{statusIcon.running}</span>}
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">{rows}</CollapsibleContent>
    </Collapsible>
  )
}

function ToolRow({ call, reveal }: { call: ToolCall; reveal: FindRevealRequest | null }) {
  const truncate = reveal === null ? "truncate" : "wrap-anywhere"
  const { summary } = describeToolCall(call)
  const skills = skillsUsed(call)
  const Icon = skills === null ? (toolIcons[ownToolName(call.name)] ?? ToolsIcon) : SkillIcon
  const images = toolOutputImages(call.output)
  return (
    <Collapsible>
      <div className="@container flex items-center gap-1">
        <CollapsibleTrigger className={cn(disclosureTrigger, "min-w-0 flex-1")}>
          <Icon aria-hidden className="size-4 shrink-0" />
          {skills !== null ? (
            <SkillLabel skills={skills} truncate={truncate} />
          ) : call.name === "Bash" ? (
            <CommandLabel call={call} truncate={truncate} />
          ) : (
            <ToolLabel call={call} truncate={truncate} />
          )}
          {call.status !== "done" && (
            <span className="shrink-0" title={statusLabel[call.status]()}>
              {statusIcon[call.status]}
              <span className="sr-only">{statusLabel[call.status]()}</span>
            </span>
          )}
          <Chevron />
        </CollapsibleTrigger>
        {call.name === "Bash" && call.status === "running" && <MoveToBackgroundButton callId={call.callId} />}
      </div>
      {images.length > 0 && (
        <ul className="mt-1 mb-2 flex flex-wrap gap-2 pl-6">
          {images.map((image) => (
            <li key={image.id}>
              <AttachmentView attachment={image} />
            </li>
          ))}
        </ul>
      )}
      <CollapsibleContent className="mt-1 mb-2 text-xs">
        <ToolCallDetails call={call} summary={summary} inGroup />
      </CollapsibleContent>
    </Collapsible>
  )
}

function MoveToBackgroundButton({ callId }: { callId: string }) {
  const { threadId } = use(PartMessage)
  const provider = useThreads((state) => state.byId[threadId]?.provider)
  if (provider === undefined || !providerInfo[provider].movesCommandsToBackground) return null
  const move = async () => {
    try {
      const moved = await callPromise("backgroundTasks.moveCommand", { threadId, callId })
      if (!moved) toast(m.tool_command_already_finished())
    } catch (cause) {
      toast.error(m.tool_command_move_to_background_failed({ message: errorMessage(cause) }))
    }
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      action={move}
      aria-label={m.tool_command_move_to_background()}
      title={m.tool_command_move_to_background()}
      className="shrink-0 reveal-when-slow rounded-full border-border font-normal text-muted-foreground"
    >
      <RiSendToBack aria-hidden />
      <span className="@max-sm:hidden">{m.tool_command_move_to_background()}</span>
    </Button>
  )
}

function SkillLabel({ skills, truncate }: { skills: ReadonlyArray<string>; truncate: string }) {
  const text = skillUseText(skills, use(SkillLabels))
  return (
    <span className={cn("min-w-0", truncate)} title={text}>
      <Highlighted text={text} />
    </span>
  )
}

function CommandLabel({ call, truncate }: { call: ToolCall; truncate: string }) {
  const { distinctLabel, command } = commandFindText(call)
  return (
    <>
      {distinctLabel !== null && (
        <span className={cn("max-w-3/4 min-w-0 shrink-0", truncate)} title={distinctLabel}>
          <Highlighted text={distinctLabel} />
        </span>
      )}
      <span className={cn("min-w-0", truncate)} title={command}>
        <Highlighted text={command} />
      </span>
    </>
  )
}

function ToolLabel({ call, truncate }: { call: ToolCall; truncate: string }) {
  const { name, summary } = describeToolCall(call)
  return (
    <>
      <span className="shrink-0">
        <Highlighted text={name} />
      </span>
      <span className={cn("min-w-0", truncate)} title={summary}>
        <Highlighted text={summary} />
      </span>
    </>
  )
}

function CommandView({
  call,
  command,
  scroll,
  fullOutputButton,
}: {
  call: ToolCall
  command: string
  scroll: string
  fullOutputButton: ReactNode
}) {
  const output = call.output === undefined ? "" : formatOutput(call.output).replace(/\n$/, "")
  return (
    <div className={cn("rounded-md bg-muted/50 p-2 font-mono", scroll)}>
      <section>
        <h4 className="sr-only">{m.tool_command()}</h4>
        <pre className="wrap-anywhere whitespace-pre-wrap">
          <ShellCode code={command} />
        </pre>
      </section>
      {(output !== "" || call.status !== "running") && (
        <section className="mt-2">
          <h4 className="sr-only">{m.tool_output()}</h4>
          {fullOutputButton}
          <pre className="ansi-output wrap-anywhere whitespace-pre-wrap text-muted-foreground">
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

function ShellCode({ code }: { code: string }) {
  return (
    <FindPatternContext value={null}>
      <HighlightedCode code={code} language="shellscript" />
    </FindPatternContext>
  )
}

function ToolSection({
  label,
  text,
  scroll,
  fullOutputButton,
}: {
  label: string
  text: string
  scroll: string
  fullOutputButton?: ReactNode
}) {
  return (
    <section>
      <h4 className="mb-1 font-medium text-muted-foreground">{label}</h4>
      {fullOutputButton}
      <pre className={cn("rounded-md bg-muted/50 p-2 font-mono wrap-anywhere whitespace-pre-wrap", scroll)}>{text}</pre>
    </section>
  )
}

function FileChangePart({ path, diff }: { path: string; diff: string }) {
  const row = (
    <>
      <FileDiffIcon aria-hidden className="size-4 shrink-0" />
      <span className="shrink-0">{m.file_change_label()}</span>
      <span className="min-w-0 truncate" title={path}>
        <Highlighted text={path} />
      </span>
    </>
  )
  if (diff === "")
    return <div className="my-2 flex items-center gap-2 py-0.5 text-sm text-receding-foreground">{row}</div>
  return (
    <Collapsible className="my-2">
      <CollapsibleTrigger className={disclosureTrigger}>
        {row}
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{diff}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

const formatTokens = (tokens: number) => new Intl.NumberFormat(getLocale(), { notation: "compact" }).format(tokens)

function CompactionPart({ compaction }: { compaction: Compaction }) {
  return (
    <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <CompactionLabel compaction={compaction} />
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

function SessionImportPart({
  provider,
  history,
}: {
  provider: AccountProviderId
  history: "replayed" | "unavailable"
}) {
  const agent = providerLabel[provider]()
  return (
    <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex max-w-[80%] items-center gap-1.5 text-center">
        <ProviderIcon provider={provider} />
        {history === "replayed" ? m.session_imported({ agent }) : m.session_imported_unavailable({ agent })}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

function AgentSwitchPart({ from, to }: { from: ProviderId; to: ProviderId }) {
  return (
    <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <ProviderIcon provider={to} />
        {m.agent_switched({ from: providerLabel[from](), to: providerLabel[to]() })}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

function SignedOutPart({ message, loginCommand }: { message: string; loginCommand: string | undefined }) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="my-2 flex flex-col gap-2 rounded-lg border border-attention/30 bg-attention/10 p-3"
    >
      <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-attention">
        <WarningIcon aria-hidden className="size-4 shrink-0" />
        {m.message_signed_out_title()}
      </h3>
      <p className="text-sm wrap-break-word text-muted-foreground">{message}</p>
      {loginCommand === undefined ? (
        <p className="text-sm">{m.message_signed_out_docs_hint()}</p>
      ) : (
        <>
          <p className="text-sm">{m.message_signed_out_hint()}</p>
          <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted py-1 ps-3 pe-1">
            <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{loginCommand}</code>
            <CopyButton value={loginCommand} label={m.message_copy_login_command()} />
          </div>
        </>
      )}
    </section>
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
          <CollapseIcon aria-hidden className="size-3.5 shrink-0" />
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
          <WarningIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
          {m.compaction_failed()}
          {compaction.message !== null && <span className="min-w-0">{compaction.message}</span>}
        </span>
      )
  }
}
