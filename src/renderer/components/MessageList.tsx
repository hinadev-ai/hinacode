import { LegendList } from "@legendapp/list/react"
import { memo } from "react"
import type { Message } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { MessagePartView } from "./MessagePart.tsx"

const keyExtractor = (message: Message) => message.id
const renderItem = ({ item }: { item: Message }) => <MessageItem message={item} />

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
      className="min-h-0 flex-1"
      contentContainerStyle={{ paddingBlock: 16 }}
    />
  )
}

const MessageItem = memo(function MessageItem({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <article aria-label={m.message_you()} className="mx-auto flex w-full max-w-3xl justify-end px-4 py-2">
        <div className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
          {message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
        </div>
      </article>
    )
  }
  const streaming = message.completedAt === null
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
