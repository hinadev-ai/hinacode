import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { createContext, memo, type ReactElement, use, type Ref, useMemo, useState } from "react"
import type { Message } from "../../shared/domain.ts"
import { fenceCode, highlight, type KnownTokens } from "../../shared/composerSyntax.ts"
import { THREAD_MENTION } from "../../shared/threadMention.ts"
import {
  assistantPresentation,
  type IndexedMessagePart,
  isActivity,
  presentationBlocks,
} from "../lib/assistantPresentation.ts"
import { faviconOrigins, linkify } from "../lib/linkify.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { AttachmentView } from "./AttachmentView.tsx"
import { FindPartContext, Highlighted } from "./FindHighlight.tsx"
import { HighlightedCode } from "./HighlightedCode.tsx"
import { Markdown } from "./Markdown.tsx"
import { MessagePartView, ToolGroup, useFindDisclosure } from "./MessagePart.tsx"
import { PostedQuestionsCard } from "./QuestionCard.tsx"
import { FaviconOrigins, WebLink } from "./WebLink.tsx"
import { WorkedFor } from "./WorkedFor.tsx"

const keyExtractor = (message: Message) => message.id
const ESTIMATED_MESSAGE_SIZE = 500
const getItemType = (message: Message) => message.role
const renderItem = ({ item }: { item: Message }) => <MessageItem message={item} />
// Spacers instead of container padding: the list measures header and footer, but not padding.
const edgeSpacer = <div className="h-4" />
// The thread's composer floats over the list's end, see `useDockHeight`.
const endSpacer = <div className="h-[calc(var(--dock-height,0px)+1rem)]" />

/** Posted questions stay answerable only while nothing has been said after them. */
const AnswerableContext = createContext<{
  readonly lastMessageId: string | undefined
  readonly providerLabel: string
  readonly showElapsedTime: boolean
}>({
  lastMessageId: undefined,
  providerLabel: "",
  showElapsedTime: true,
})

/**
 * Bottom-anchored virtual list. `maintainScrollAtEnd` follows streaming output only while the
 * viewport is already near the end, so scrolling up to read stops the auto-scroll.
 */
export function MessageList({
  messages,
  providerLabel,
  listRef,
  header,
  alignItemsAtEnd = true,
  showElapsedTime = true,
}: {
  messages: ReadonlyArray<Message>
  providerLabel: string
  listRef?: Ref<LegendListRef>
  /** Scrolls with the messages and stays right above them. */
  header?: ReactElement
  /** Chat sits at the bottom, by the composer. A log reads from the top. */
  alignItemsAtEnd?: boolean
  showElapsedTime?: boolean
}) {
  const lastMessageId = messages.at(-1)?.id
  const answerable = useMemo(
    () => ({ lastMessageId, providerLabel, showElapsedTime }),
    [lastMessageId, providerLabel, showElapsedTime],
  )
  return (
    <AnswerableContext value={answerable}>
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
        className="min-h-0 flex-1"
      />
    </AnswerableContext>
  )
}

const MessageItem = memo(function MessageItem({ message }: { message: Message }) {
  const faviconSites = useMemo(
    () => faviconOrigins(message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))),
    [message.parts],
  )
  return (
    <FaviconOrigins value={faviconSites}>
      <MessageBody message={message} />
    </FaviconOrigins>
  )
})

/** Plain text with each `@thread:<id>` of a known thread shown as a link titled `@<title>`. */
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

/** A sent message only shows code apart; links and thread mentions are found by `linkify` and `WithThreadMentions`. */
const NO_KNOWN_TOKENS: KnownTokens = { commands: new Set(), files: new Set(), threads: new Set() }

/** Sits on the bubble's fill, which is the same color as `bg-muted`. */
const insetCode = "bg-background font-mono text-[0.91em]"

/** What the developer sent: fenced blocks as code cards without their fence lines, and inline code as pills. */
function SentText({ text }: { text: string }) {
  const repository = useThreadRepository()
  const segments = highlight(text, NO_KNOWN_TOKENS)
  return segments.map((segment, index) => {
    if (segment.kind === "fence")
      return (
        <pre key={index} className={cn(insetCode, "my-1.5 overflow-x-auto rounded-lg px-3 py-2 whitespace-pre")}>
          <code>
            <HighlightedCode code={fenceCode(segment)} language={segment.language} />
          </code>
        </pre>
      )
    if (segment.kind === "code")
      return (
        <code key={index} className={cn(insetCode, "rounded-[0.25em] px-[0.3em] py-[0.1em]")}>
          <Highlighted text={segment.text.slice(1, -1)} />
        </code>
      )
    // The line breaks around a code card would add blank lines beside it.
    let prose = segment.text
    if (segments[index - 1]?.kind === "fence") prose = prose.replace(/^\n/, "")
    if (segments[index + 1]?.kind === "fence") prose = prose.replace(/\n$/, "")
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
  const { showElapsedTime } = use(AnswerableContext)
  if (message.role === "user") {
    const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    const attachments = message.parts.flatMap((part) => (part.type === "attachment" ? [part.attachment] : []))
    return (
      <article
        aria-label={m.message_you()}
        data-message-id={message.id}
        className="mx-auto flex w-full max-w-3xl flex-col items-end gap-1.5 px-4 py-2"
      >
        {attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {attachments.map((attachment) => (
              <AttachmentView key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        {text !== "" && (
          <div className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap wrap-break-word text-secondary-foreground">
            <FindPartContext value={message.parts.findIndex((part) => part.type === "text")}>
              <SentText text={text} />
            </FindPartContext>
          </div>
        )}
      </article>
    )
  }
  return <AssistantBody message={message} showElapsedTime={showElapsedTime} />
}

function AssistantBody({ message, showElapsedTime }: { message: Message; showElapsedTime: boolean }) {
  const presentation = assistantPresentation(message, showElapsedTime)
  const { parts } = presentation
  const reveal = useUi((state) => state.findReveal)
  const revealsActivity =
    reveal !== null &&
    reveal.match.messageId === message.id &&
    parts.some(({ part, index }) => index === reveal.match.partIndex && isActivity(part))
  const [activityShown, setActivityShown] = useFindDisclosure(revealsActivity ? reveal : null)
  const streaming = message.completedAt === null
  // A steer sent before the agent said anything closes an empty assistant message.
  if (!streaming && parts.length === 0) return null
  const last = parts.at(-1)
  const writingIndex = streaming && last?.part.type === "text" ? last.index : undefined
  const hasActivity = parts.some(({ part }) => isActivity(part))
  const shownParts =
    presentation.kind === "completed" && !activityShown ? parts.filter(({ part }) => !isActivity(part)) : parts
  return (
    <article
      aria-busy={streaming}
      data-message-id={message.id}
      className="mx-auto w-full max-w-3xl px-4 py-2 text-sm leading-normal"
    >
      {presentation.kind === "completed" && (
        <WorkedFor
          durationMs={presentation.durationMs}
          expanded={activityShown}
          onExpandedChange={hasActivity ? setActivityShown : undefined}
        />
      )}
      <AssistantParts message={message} parts={shownParts} writingIndex={writingIndex} />
      {streaming && (parts.length === 0 || writingIndex !== undefined) && (
        <p className="animate-shimmer text-xs text-shimmer motion-reduce:animate-none">
          {writingIndex !== undefined ? m.message_writing() : m.message_thinking()}
        </p>
      )}
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
  const { lastMessageId, providerLabel } = use(AnswerableContext)
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
        ) : part.type === "questions" && message.id === lastMessageId ? (
          <PostedQuestionsCard threadId={message.threadId} questions={part.questions} providerLabel={providerLabel} />
        ) : (
          <MessagePartView part={part} />
        )}
      </FindPartContext>
    )
  })
}

/**
 * Reply text appears whole once the agent has finished it, instead of word by word. Only text that
 * finishes while on screen fades in, so opening a thread or scrolling the list back does not replay it.
 */
function ReplyText({ text, done }: { text: string; done: boolean }) {
  const [finishedOnScreen] = useState(!done)
  if (!done) return null
  return (
    <div className={finishedOnScreen ? "animate-fade-in" : undefined}>
      <Markdown text={text} />
    </div>
  )
}

export function EmptyThread({ providerLabel }: { providerLabel: string }) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-1 px-4 text-center">
      <h2 className="text-sm font-semibold">{m.thread_empty_title()}</h2>
      <p className="text-sm text-muted-foreground">{m.thread_empty_hint({ provider: providerLabel })}</p>
    </div>
  )
}
