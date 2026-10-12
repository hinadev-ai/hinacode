import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { createContext, memo, type ReactElement, use, type Ref, useMemo, useState } from "react"
import type { Message } from "../../shared/domain.ts"
import { assistantPresentation, type IndexedMessagePart } from "../lib/assistantPresentation.ts"
import { faviconOrigins, linkify } from "../lib/linkify.ts"
import { useThreadRepository } from "../lib/threadRepository.ts"
import { m } from "../paraglide/messages.js"
import { AttachmentView } from "./AttachmentView.tsx"
import { Highlighted } from "./FindHighlight.tsx"
import { Markdown } from "./Markdown.tsx"
import { MessagePartView } from "./MessagePart.tsx"
import { PostedQuestionsCard } from "./QuestionCard.tsx"
import { FaviconOrigins, WebLink } from "./WebLink.tsx"
import { WorkedFor } from "./WorkedFor.tsx"

const keyExtractor = (message: Message) => message.id
const renderItem = ({ item }: { item: Message }) => <MessageItem message={item} />
// Spacers instead of container padding: the list measures header and footer, but not padding.
const edgeSpacer = <div className="h-4" />

/** Posted questions stay answerable only while nothing has been said after them. */
const AnswerableContext = createContext<{
  readonly lastMessageId: string | undefined
  readonly providerLabel: string
  readonly summarizeWork: boolean
}>({
  lastMessageId: undefined,
  providerLabel: "",
  summarizeWork: true,
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
  summarizeWork = true,
}: {
  messages: ReadonlyArray<Message>
  providerLabel: string
  listRef?: Ref<LegendListRef>
  /** Scrolls with the messages and stays right above them. */
  header?: ReactElement
  /** Chat sits at the bottom, by the composer. A log reads from the top. */
  alignItemsAtEnd?: boolean
  summarizeWork?: boolean
}) {
  const lastMessageId = messages.at(-1)?.id
  const answerable = useMemo(
    () => ({ lastMessageId, providerLabel, summarizeWork }),
    [lastMessageId, providerLabel, summarizeWork],
  )
  return (
    <AnswerableContext value={answerable}>
      <LegendList
        ref={listRef}
        data={messages}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        estimatedItemSize={120}
        alignItemsAtEnd={alignItemsAtEnd}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainVisibleContentPosition
        ListHeaderComponent={header ?? edgeSpacer}
        ListFooterComponent={edgeSpacer}
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

function MessageBody({ message }: { message: Message }) {
  const repository = useThreadRepository()
  const { summarizeWork } = use(AnswerableContext)
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
          <div className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
            {linkify(text, repository).map((segment, index) =>
              segment.type === "link" ? (
                <WebLink key={index} href={segment.href}>
                  <Highlighted text={segment.text} />
                </WebLink>
              ) : (
                <Highlighted key={index} text={segment.text} />
              ),
            )}
          </div>
        )}
      </article>
    )
  }
  const presentation = assistantPresentation(message, summarizeWork)
  const completed = presentation.kind === "completed"
  const shown = completed ? presentation.reply : presentation.parts
  const streaming = message.completedAt === null
  // A steer sent before the agent said anything closes an empty assistant message.
  if (!streaming && shown.length === 0 && (!completed || presentation.work.length === 0)) return null
  const last = shown.at(-1)
  const writingIndex = streaming && last?.part.type === "text" ? last.index : undefined
  return (
    <article
      aria-busy={streaming}
      data-message-id={message.id}
      className="mx-auto w-full max-w-3xl px-4 py-2 text-sm leading-relaxed"
    >
      {completed && (
        <WorkedFor durationMs={presentation.durationMs} work={presentation.work}>
          {presentation.work.map((indexed) => (
            <AssistantPart key={indexed.index} message={message} indexed={indexed} done />
          ))}
        </WorkedFor>
      )}
      {shown.map((indexed) => (
        <AssistantPart key={indexed.index} message={message} indexed={indexed} done={indexed.index !== writingIndex} />
      ))}
      {streaming && (shown.length === 0 || writingIndex !== undefined) && (
        <p className="animate-pulse text-xs text-muted-foreground motion-reduce:animate-none">
          {writingIndex !== undefined ? m.message_writing() : m.message_thinking()}
        </p>
      )}
    </article>
  )
}

function AssistantPart({
  message,
  indexed: { part },
  done,
}: {
  message: Message
  indexed: IndexedMessagePart
  done: boolean
}) {
  const { lastMessageId, providerLabel } = use(AnswerableContext)
  if (part.type === "text") return <ReplyText text={part.text} done={done} />
  if (part.type === "questions" && message.id === lastMessageId) {
    return <PostedQuestionsCard threadId={message.threadId} questions={part.questions} providerLabel={providerLabel} />
  }
  return <MessagePartView part={part} />
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
