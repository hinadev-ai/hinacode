import { LegendList } from "@legendapp/list/react"
import { memo } from "react"
import type { Message } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { AttachmentView } from "./AttachmentView.tsx"
import { MessagePartView } from "./MessagePart.tsx"

const keyExtractor = (message: Message) => message.id
const renderItem = ({ item }: { item: Message }) => <MessageItem message={item} />
// Spacers instead of container padding: the list measures header and footer, but not padding.
const edgeSpacer = <div className="h-4" />

/**
 * Bottom-anchored virtual list. `maintainScrollAtEnd` follows streaming output only while the
 * viewport is already near the end, so scrolling up to read stops the auto-scroll.
 */
export function MessageList({ messages }: { messages: ReadonlyArray<Message> }) {
  return (
    <LegendList
      data={messages}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      estimatedItemSize={120}
      alignItemsAtEnd
      initialScrollAtEnd
      maintainScrollAtEnd
      maintainVisibleContentPosition
      ListHeaderComponent={edgeSpacer}
      ListFooterComponent={edgeSpacer}
      className="min-h-0 flex-1"
    />
  )
}

const MessageItem = memo(function MessageItem({ message }: { message: Message }) {
  if (message.role === "user") {
    const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    const attachments = message.parts.flatMap((part) => (part.type === "attachment" ? [part.attachment] : []))
    return (
      <article
        aria-label={m.message_you()}
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
            {text}
          </div>
        )}
      </article>
    )
  }
  const streaming = message.completedAt === null
  // A steer sent before the agent said anything closes an empty assistant message.
  if (!streaming && message.parts.length === 0) return null
  return (
    <article aria-busy={streaming} className="mx-auto w-full max-w-3xl px-4 py-2 text-sm leading-relaxed">
      {message.parts.map((part, index) => (
        // Parts only ever get appended or updated in place, so the index is a stable key.
        <MessagePartView key={index} part={part} />
      ))}
      {streaming && message.parts.length === 0 && (
        <p className="animate-pulse text-xs text-muted-foreground motion-reduce:animate-none">{m.message_thinking()}</p>
      )}
    </article>
  )
})

export function EmptyThread({ providerLabel }: { providerLabel: string }) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-1 px-4 text-center">
      <h2 className="text-sm font-semibold">{m.thread_empty_title()}</h2>
      <p className="text-sm text-muted-foreground">{m.thread_empty_hint({ provider: providerLabel })}</p>
    </div>
  )
}
