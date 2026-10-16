// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events -- the WAI-ARIA combobox pattern: a textarea driving a listbox through aria-activedescendant, which <datalist> cannot do. Keys reach the options through the textarea.
import {
  type ComponentProps,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { RiFileLine } from "react-icons/ri"
import type { AgentCommand } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import {
  completionAt,
  highlight,
  type Suggestion,
  suggestionsFor,
  type SyntaxKind,
} from "../../shared/composerSyntax.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { ProviderIcon } from "./ProviderIcon.tsx"

/** Colors only, never font or spacing: the highlighted copy must wrap exactly like the textarea above it. */
const syntaxClass: Record<SyntaxKind, string> = {
  text: "text-foreground",
  bullet: "text-muted-foreground",
  code: "rounded-sm bg-muted text-foreground",
  command: "text-syntax-token",
  mention: "text-syntax-token",
}

/** Shared by the textarea and the highlighted copy under it, so both lay text out identically. */
const textLayout =
  "col-start-1 row-start-1 max-h-60 px-2.5 py-2 text-base whitespace-pre-wrap [overflow-wrap:break-word] [scrollbar-gutter:stable] md:text-sm"

interface ComposerInputProps extends Omit<ComponentProps<"textarea">, "value" | "onChange" | "ref"> {
  readonly ref?: Ref<HTMLTextAreaElement>
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly commands: ReadonlyArray<AgentCommand>
  /** Workspace paths offered after `@`. */
  readonly files: ReadonlyArray<string>
  /** Other threads offered after `@`, before the files. */
  readonly threads: ReadonlyArray<Thread>
}

/**
 * The composer's textarea with Markdown-ish highlighting and completion of `/commands`, `$skills` and
 * `@` mentions of threads and files. The textarea's own text is transparent and sits over a highlighted copy of the same text.
 * The suggestion list is positioned against the nearest positioned ancestor, the composer box.
 */
export function ComposerInput({
  ref,
  value,
  onValueChange,
  commands,
  files,
  threads,
  onKeyDown,
  className,
  ...props
}: ComposerInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState({ start: -1, index: 0 })
  /** Start of the token whose suggestions Escape closed; they stay closed until another token is typed. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  useImperativeHandle(ref, () => textareaRef.current!, [])

  const known = useMemo(
    () => ({
      commands: new Set(commands.map((command) => command.trigger + command.name)),
      files: new Set(files),
      threads: new Set(threads.map((thread) => thread.id)),
    }),
    [commands, files, threads],
  )
  const segments = useMemo(() => highlight(value, known), [value, known])

  const completion = completionAt(value, caret)
  const suggestions =
    completion && completion.start !== dismissedAt ? suggestionsFor(completion, commands, files, threads) : []
  const open = completion !== null && suggestions.length > 0
  const activeIndex = completion?.start === selected.start ? Math.min(selected.index, suggestions.length - 1) : 0
  const optionId = (index: number) => `${listId}-${index}`

  useEffect(() => {
    if (open) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" })
  })

  const pick = (suggestion: Suggestion) => {
    if (completion === null) return
    const insert = `${suggestion.insert} `
    const rest = value.slice(completion.end).replace(/^ /, "")
    const position = completion.start + insert.length
    // Rendering the new value moves the caret to the end, so render now and put the caret after the insert.
    flushSync(() => onValueChange(value.slice(0, completion.start) + insert + rest))
    textareaRef.current?.setSelectionRange(position, position)
    setCaret(position)
  }

  const move = (step: 1 | -1) =>
    setSelected({
      start: completion?.start ?? -1,
      index: (activeIndex + step + suggestions.length) % suggestions.length,
    })

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !event.nativeEvent.isComposing) {
      const suggestion = suggestions[activeIndex]
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        move(event.key === "ArrowDown" ? 1 : -1)
        return
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && suggestion) {
        event.preventDefault()
        pick(suggestion)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        setDismissedAt(completion.start)
        return
      }
    }
    onKeyDown?.(event)
  }

  return (
    <>
      <div className="grid min-h-0">
        <div ref={highlightRef} aria-hidden className={cn(textLayout, "pointer-events-none overflow-hidden")}>
          {segments.map((segment, index) => (
            <span key={index} className={syntaxClass[segment.kind]}>
              {segment.text}
            </span>
          ))}
          {/* A trailing newline only takes up a line in the textarea once something follows it. */}
          {"​"}
        </div>
        <textarea
          ref={textareaRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value)
            setCaret(event.target.selectionStart)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onScroll={(event) => {
            if (highlightRef.current) highlightRef.current.scrollTop = event.currentTarget.scrollTop
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            textLayout,
            "field-sizing-content min-h-0 w-full resize-none bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
            className,
          )}
          {...props}
        />
      </div>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={completion.trigger === "@" ? m.composer_mentions_label() : m.composer_commands_label()}
          className="absolute inset-x-0 bottom-full mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.insert}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              // Keeps focus, and the caret, in the textarea.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(suggestion)}
              onMouseMove={() => index !== activeIndex && setSelected({ start: completion.start, index })}
              className="flex cursor-default items-baseline gap-2 rounded-lg px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <SuggestionRow suggestion={suggestion} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  if (suggestion.type === "thread") {
    const { thread } = suggestion
    return (
      <>
        <span className="self-center">
          <ProviderIcon provider={thread.provider} />
        </span>
        <span className="min-w-0 truncate">{thread.title}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{thread.model}</span>
      </>
    )
  }
  if (suggestion.type === "file") {
    const slash = suggestion.path.lastIndexOf("/")
    return (
      <>
        <RiFileLine aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" />
        <span className="shrink-0 font-mono">{suggestion.path.slice(slash + 1)}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{suggestion.path.slice(0, slash + 1)}</span>
      </>
    )
  }
  const { command } = suggestion
  return (
    <>
      <span className="shrink-0 font-mono">{suggestion.insert}</span>
      {command.argumentHint !== "" && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{command.argumentHint}</span>
      )}
      <span className="min-w-0 truncate text-xs text-muted-foreground">{command.description}</span>
    </>
  )
}
