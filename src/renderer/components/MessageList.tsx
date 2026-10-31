import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { createContext, Fragment, type ReactElement, type ReactNode, use, type Ref, useState } from "react"
import type { AgentCommand } from "../../shared/agent.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { fenceCode, highlight, type KnownTokens, type Segment } from "../../shared/composerSyntax.ts"
import { THREAD_MENTION } from "../../shared/threadMention.ts"
import {
  assistantPresentation,
  foldedParts,
  type IndexedMessagePart,
  presentationBlocks,
} from "../lib/assistantPresentation.ts"
import { faviconOrigins, linkify } from "../lib/linkify.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { AttachmentView } from "./AttachmentView.tsx"
import { CommandChip } from "./CommandChip.tsx"
import { FindPartContext, Highlighted } from "./FindHighlight.tsx"
import { HighlightedCode } from "./HighlightedCode.tsx"
import { Markdown } from "./Markdown.tsx"
import { MessageActions } from "./MessageActions.tsx"
import { MessagePartView, PartThread, ToolGroup, useFindDisclosure } from "./MessagePart.tsx"
import { PostedQuestionsCard } from "./QuestionCard.tsx"
import { FaviconOrigins, WebLink } from "./WebLink.tsx"
import { EarlierActivity, WorkedFor } from "./WorkedFor.tsx"

const keyExtractor = (message: Message) => message.id
const ESTIMATED_MESSAGE_SIZE = 500
const getItemType = (message: Message) => message.role
const renderItem = ({ item }: { item: Message }) => <MessageItem message={item} />
// FIXME: LegendList measures its header and footer, but not its padding
const edgeSpacer = <div className="h-4" />
const endSpacer = <div className="h-[calc(var(--dock-height,0px)+1rem)]" />

const TranscriptContext = createContext<{
  readonly providerLabel: string
  readonly showElapsedTime: boolean
  readonly commands: ReadonlyArray<AgentCommand>
}>({
  providerLabel: "",
  showElapsedTime: true,
  commands: [],
})

const LastMessageContext = createContext<string | undefined>(undefined)

export function MessageList({
  messages,
  providerLabel,
  listRef,
  header,
  alignItemsAtEnd = true,
  showElapsedTime = true,
  commands = [],
}: {
  messages: ReadonlyArray<Message>
  providerLabel: string
  commands?: ReadonlyArray<AgentCommand>
  listRef?: Ref<LegendListRef>
  header?: ReactElement
  alignItemsAtEnd?: boolean
  showElapsedTime?: boolean
}) {
  const transcript = { providerLabel, showElapsedTime, commands }
  return (
    <TranscriptContext value={transcript}>
      <LastMessageContext value={messages.at(-1)?.id}>
        <LegendList
          ref={listRef}
          data={messages}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={ESTIMATED_MESSAGE_SIZE}
          getItemType={getItemType}
          alignItemsAtEnd={alignItemsAtEnd}
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainVisibleContentPosition
          ListHeaderComponent={header ?? edgeSpacer}
          ListFooterComponent={endSpacer}
          className="min-h-0 flex-1 scroll-fade"
        />
      </LastMessageContext>
    </TranscriptContext>
  )
}

function MessageItem({ message }: { message: Message }) {
  const faviconSites = faviconOrigins(message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
  return (
    <FaviconOrigins value={faviconSites}>
      <MessageBody message={message} />
    </FaviconOrigins>
  )
}

function WithThreadMentions({ text }: { text: string }) {
  const threadsById = useThreads((state) => state.byId)
  const nodes: Array<ReactElement> = []
  let end = 0
  for (const match of text.matchAll(THREAD_MENTION)) {
    const thread = threadsById[match[1] ?? ""]
    if (thread === undefined) continue
    nodes.push(<Highlighted key={`text-${end}`} text={text.slice(end, match.index)} />)
    nodes.push(
      <Link
        key={`thread-${match.index}`}
        to="/thread/$threadId"
        params={{ threadId: thread.id }}
        className="text-syntax-token underline-offset-2 hover:underline"
      >
        <Highlighted text={`@${thread.title}`} />
      </Link>,
    )
    end = match.index + match[0].length
  }
  nodes.push(<Highlighted key={`text-${end}`} text={text.slice(end)} />)
  return nodes
}

const isBlock = (segment: Segment | undefined) => segment?.kind === "fence" || segment?.kind === "rule"

const insetCode = "bg-background font-mono text-[0.91em]"

function SentText({ text, commands }: { text: string; commands: ReadonlyArray<AgentCommand> }) {
  const repository = useThreadRepository()
  const byToken = new Map(commands.map((command) => [command.trigger + command.name, command]))
  const known: KnownTokens = {
    commands: new Set(byToken.keys()),
    files: new Set(),
    threads: new Set(),
  }
  const segments = highlight(text, known)
  return segments.map((segment, index) => {
    if (segment.kind === "fence")
      return (
        <pre key={index} className={cn(insetCode, "my-1.5 overflow-x-auto rounded-lg px-3 py-2 whitespace-pre")}>
          <code>
            <HighlightedCode code={fenceCode(segment)} language={segment.language} />
          </code>
        </pre>
      )
    if (segment.kind === "rule") return <hr key={index} className="my-2 border-border" />
    if (segment.kind === "strong")
      return (
        <strong key={index} className="font-semibold">
          <Highlighted text={segment.text.slice(2, -2)} />
        </strong>
      )
    if (segment.kind === "code")
      return (
        <code key={index} className={cn(insetCode, "rounded-[0.25em] px-[0.3em] py-[0.1em]")}>
          <Highlighted text={segment.text.slice(1, -1)} />
        </code>
      )
    const command = segment.kind === "command" ? byToken.get(segment.text) : undefined
    if (command !== undefined)
      return (
        <CommandChip key={index} command={command}>
          <Highlighted text={command.label ?? command.name} />
        </CommandChip>
      )
    let prose = segment.text
    if (isBlock(segments[index - 1])) prose = prose.replace(/^\n/, "")
    if (isBlock(segments[index + 1])) prose = prose.replace(/\n$/, "")
    return linkify(prose, repository).map((link, linkIndex) =>
      link.type === "link" ? (
        <WebLink key={`${index}:${linkIndex}`} href={link.href}>
          <Highlighted text={link.text} />
        </WebLink>
      ) : (
        <WithThreadMentions key={`${index}:${linkIndex}`} text={link.text} />
      ),
    )
  })
}

function MessageBody({ message }: { message: Message }) {
  const { showElapsedTime, commands } = use(TranscriptContext)
  if (message.role === "user") {
    const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    const attachments = message.parts.flatMap((part) => (part.type === "attachment" ? [part.attachment] : []))
    return (
      <article
        aria-label={m.message_you()}
        data-message-id={message.id}
        className="group/message clear-overview mx-auto flex w-full max-w-3xl flex-col items-end gap-1.5 px-4 py-2"
      >
        {attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {attachments.map((attachment) => (
              <AttachmentView key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        {text !== "" && (
          <div className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm leading-(--leading-message) whitespace-pre-wrap wrap-break-word text-secondary-foreground">
            <FindPartContext value={message.parts.findIndex((part) => part.type === "text")}>
              <SentText text={text} commands={commands} />
            </FindPartContext>
          </div>
        )}
        <MessageActions message={message} className="-mt-1" />
      </article>
    )
  }
  return <AssistantBody message={message} showElapsedTime={showElapsedTime} />
}

function AssistantBody({ message, showElapsedTime }: { message: Message; showElapsedTime: boolean }) {
  const presentation = assistantPresentation(message, showElapsedTime)
  const { parts } = presentation
  const folded = foldedParts(presentation)
  const reveal = useUi((state) => state.findReveal)
  const revealsHidden =
    reveal !== null &&
    reveal.match.messageId === message.id &&
    parts.some(({ index }) => index === reveal.match.partIndex) &&
    !folded.some(({ index }) => index === reveal.match.partIndex)
  const [activityShown, setActivityShown] = useFindDisclosure(revealsHidden ? reveal : null)
  const streaming = message.completedAt === null
  if (!streaming && parts.length === 0) return null
  const last = parts.at(-1)
  const writingIndex = streaming && last?.part.type === "text" ? last.index : undefined
  const foldedCount = parts.length - folded.length
  const shownParts = activityShown ? parts : folded
  return (
    <article
      aria-busy={streaming}
      data-message-id={message.id}
      className="group/message clear-overview mx-auto w-full max-w-3xl px-4 py-2 text-sm leading-(--leading-message)"
    >
      {presentation.kind === "completed" ? (
        <WorkedFor
          durationMs={presentation.durationMs}
          expanded={activityShown}
          onExpandedChange={foldedCount > 0 ? setActivityShown : undefined}
        />
      ) : (
        foldedCount > 0 && (
          <EarlierActivity count={foldedCount} expanded={activityShown} onExpandedChange={setActivityShown} />
        )
      )}
      <PartThread value={message.threadId}>
        <AssistantParts message={message} parts={shownParts} writingIndex={writingIndex} />
      </PartThread>
      {streaming && (parts.length === 0 || writingIndex !== undefined) && (
        <p className="text-xs text-shimmer">
          {writingIndex !== undefined ? m.message_writing() : m.message_thinking()}
        </p>
      )}
      {!streaming && <MessageActions message={message} className="-ml-2" />}
    </article>
  )
}

function AssistantParts({
  message,
  parts,
  writingIndex,
}: {
  message: Message
  parts: ReadonlyArray<IndexedMessagePart>
  writingIndex?: number
}) {
  return presentationBlocks(parts).map((block) => {
    const { index } = block
    if (block.type === "tools") {
      return <ToolGroup key={index} messageId={message.id} index={index} calls={block.calls} />
    }
    const { part } = block
    return (
      <FindPartContext key={index} value={index}>
        {part.type === "text" ? (
          <ReplyText text={part.text} done={index !== writingIndex} />
        ) : part.type === "questions" ? (
          <QuestionsPart message={message} part={part} />
        ) : (
          <MessagePartView part={part} />
        )}
      </FindPartContext>
    )
  })
}

function QuestionsPart({ message, part }: { message: Message; part: Extract<MessagePart, { type: "questions" }> }) {
  const lastMessageId = use(LastMessageContext)
  const { providerLabel } = use(TranscriptContext)
  return message.id === lastMessageId ? (
    <PostedQuestionsCard threadId={message.threadId} questions={part.questions} providerLabel={providerLabel} />
  ) : (
    <MessagePartView part={part} />
  )
}

function ReplyText({ text, done }: { text: string; done: boolean }) {
  const [finishedOnScreen] = useState(!done)
  if (!done) return null
  return <Markdown text={text} className={finishedOnScreen ? "animate-fade-in" : undefined} />
}

const PROJECT = "\uE000"
const ENVIRONMENT = "\uE001"

export function EmptyThread({ project, environment }: { project: ReactNode | null; environment: ReactNode }) {
  const sentence =
    project === null
      ? m.thread_empty_chat_title({ environment: ENVIRONMENT })
      : m.thread_empty_title({ project: PROJECT, environment: ENVIRONMENT })
  return (
    <div className="m-auto flex max-w-xl flex-col items-center px-4 text-center">
      <h2 className="text-2xl font-semibold text-balance">
        {sentence.split(/([\uE000\uE001])/).map((part, index) => (
          <Fragment key={index}>{part === PROJECT ? project : part === ENVIRONMENT ? environment : part}</Fragment>
        ))}
      </h2>
    </div>
  )
}
