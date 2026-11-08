// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events -- the WAI-ARIA combobox pattern: the textarea drives the listbox through aria-activedescendant, and keys reach the options through the textarea.
import { useAtomValue } from "@effect/atom-react"
import { ArrowUpIcon } from "@hinacode/icons"
import { AsyncResult } from "effect/reactivity"
import { type KeyboardEvent, type RefObject, useId, useRef, useState, useTransition } from "react"
import { toast } from "sonner"
import { completionAt, matchThreads } from "../../../shared/composerSyntax.ts"
import type { Project, Thread } from "../../../shared/domain.ts"
import { mentionableThreads, threadMention } from "../../../shared/mentions.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { projectsAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useThreads } from "../../stores/threads.ts"
import { ProviderIcon } from "../ProviderIcon.tsx"
import { Button } from "../ui/button.tsx"

const MAX_MENTIONS = 8

const noProjects: ReadonlyArray<Project> = []

function useMentionableThreads(threadId: string): ReadonlyArray<Thread> {
  const byId = useThreads((state) => state.byId)
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => noProjects)
  const thread = byId[threadId]
  if (thread === undefined) return []
  return mentionableThreads(thread, Object.values(byId), projects).sameMachine
}

const scrollIntoViewNearest = (option: HTMLElement | null) => option?.scrollIntoView({ block: "nearest" })

export function CommentInput({
  threadId,
  label,
  placeholder,
  onSend,
  inputRef,
}: {
  threadId: string
  label: string
  placeholder: string
  onSend: (body: string) => Promise<void>
  inputRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const listId = useId()
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const textarea = inputRef ?? ownRef
  const [body, setBody] = useState("")
  const [caret, setCaret] = useState(0)
  const [highlighted, setHighlighted] = useState({ start: -1, index: 0 })
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [sending, startSending] = useTransition()
  const threads = useMentionableThreads(threadId)

  const completion = completionAt(body, caret)
  const mention = completion?.trigger === "@" && completion.start !== dismissedAt ? completion : null
  const matches = mention === null ? [] : matchThreads(threads, mention.query).slice(0, MAX_MENTIONS)
  const open = mention !== null && matches.length > 0
  const activeIndex = mention?.start === highlighted.start ? Math.min(highlighted.index, matches.length - 1) : 0
  const optionId = (index: number) => `${listId}-${index}`

  const pick = (thread: Thread) => {
    const element = textarea.current
    if (element === null || mention === null) return
    const end = mention.end + (body[mention.end] === " " ? 1 : 0)
    element.setRangeText(`${threadMention(thread.id)} `, mention.start, end, "end")
    setBody(element.value)
    setCaret(element.selectionStart)
    setDismissedAt(null)
    element.focus()
  }

  const send = () => {
    const text = body.trim()
    if (text === "" || sending) return
    startSending(async () => {
      try {
        await onSend(text)
        setBody("")
        setCaret(0)
      } catch (cause) {
        toast.error(m.comments_send_failed({ message: errorMessage(cause) }))
      }
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    const thread = matches[activeIndex]
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setHighlighted({ start: mention.start, index: (activeIndex + step + matches.length) % matches.length })
      return
    }
    if (open && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey && thread !== undefined) {
      event.preventDefault()
      pick(thread)
      return
    }
    if (open && event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      setDismissedAt(mention.start)
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="relative flex items-end gap-1.5 rounded-lg border border-input bg-transparent p-1 ps-2.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      <textarea
        ref={textarea}
        value={body}
        rows={1}
        role="combobox"
        aria-label={label}
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        aria-busy={sending || undefined}
        onChange={(event) => {
          setBody(event.target.value)
          setCaret(event.target.selectionStart)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className="field-sizing-content max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Button
        size="icon-sm"
        aria-label={m.comments_send()}
        title={m.comments_send()}
        disabled={body.trim() === "" || sending}
        onClick={send}
      >
        <ArrowUpIcon aria-hidden />
      </Button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={m.composer_mentions_label()}
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {matches.map((thread, index) => (
            <div
              key={thread.id}
              id={optionId(index)}
              ref={index === activeIndex ? scrollIntoViewNearest : undefined}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(thread)}
              onMouseMove={() => index !== activeIndex && setHighlighted({ start: mention.start, index })}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <ProviderIcon provider={thread.provider} />
              <span className="min-w-0 truncate">{thread.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
