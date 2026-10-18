// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events -- the WAI-ARIA combobox pattern: a textarea driving a listbox through aria-activedescendant, which <datalist> cannot do. Keys reach the options through the textarea.
import {
  type ComponentProps,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { RiFileLine, RiSlashCommands2 } from "react-icons/ri"
import type { AgentCommand } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import {
  completionAt,
  highlight,
  leadingSkill,
  type Suggestion,
  suggestionsFor,
  type SyntaxKind,
} from "../../shared/composerSyntax.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SkillIcon } from "./icons/SkillIcon.tsx"

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

/** Starts both layers' first line after the skill chip, whose width `measureChip` keeps up to date. */
const afterChip = "indent-[calc(var(--skill-chip-width)_+_--spacing(1.5))]"

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
 * A skill that starts the message shows as a chip before the text, and the textarea holds only the text after it.
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
  placeholder,
  className,
  ...props
}: ComposerInputProps) {
  const layersRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const skillId = useId()
  /** Caret, selected option and dismissed token are indexes into `text`, the part of the message in the textarea. */
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
  const skill = useMemo(() => leadingSkill(value, commands), [value, commands])
  const chipToken = skill?.token ?? ""
  const text = value.slice(chipToken.length)
  const segments = useMemo(() => highlight(text, known), [text, known])

  const completion = completionAt(text, caret)
  const suggestions =
    completion && completion.start !== dismissedAt ? suggestionsFor(completion, commands, files, threads) : []
  const open = completion !== null && suggestions.length > 0
  const activeIndex = completion?.start === selected.start ? Math.min(selected.index, suggestions.length - 1) : 0
  const optionId = (index: number) => `${listId}-${index}`

  useEffect(() => {
    if (open) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" })
  })

  /**
   * Keeps the chip's width in `--skill-chip-width` for `afterChip`. The observer reads `layersRef` when it fires,
   * because React attaches a child's ref before its parent's.
   */
  const measureChip = useCallback((element: HTMLElement | null) => {
    if (element === null) return
    const observer = new ResizeObserver(() =>
      layersRef.current?.style.setProperty("--skill-chip-width", `${element.offsetWidth}px`),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /**
   * Sets the whole message and puts the caret at `position`, an index into it. Rendering a new value moves the
   * textarea's caret to its end, so render now and put the caret back. A chip that appears or goes away shifts every
   * index into `text`, which also invalidates the dismissed token.
   */
  const replace = (next: string, position: number) => {
    const caretInText = Math.max(0, position - (leadingSkill(next, commands)?.token.length ?? 0))
    flushSync(() => onValueChange(next))
    textareaRef.current?.setSelectionRange(caretInText, caretInText)
    setCaret(caretInText)
    setDismissedAt(null)
  }

  const pick = (suggestion: Suggestion) => {
    if (completion === null) return
    const before = `${chipToken}${text.slice(0, completion.start)}${suggestion.insert} `
    replace(before + text.slice(completion.end).replace(/^ /, ""), before.length)
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
    const { selectionStart, selectionEnd } = event.currentTarget
    if (skill && event.key === "Backspace" && selectionStart === 0 && selectionEnd === 0) {
      event.preventDefault()
      replace(text, 0)
      return
    }
    onKeyDown?.(event)
  }

  return (
    <>
      <div ref={layersRef} className="grid min-h-0">
        <div
          ref={highlightRef}
          aria-hidden
          className={cn(textLayout, skill && afterChip, "pointer-events-none relative overflow-hidden")}
        >
          {skill && (
            // At the start of the first line, one line high. `indent-0` keeps it from inheriting the indent its own width
            // sets, and `max-w-1/2` leaves the first word room, which would otherwise break mid-word to fit beside the chip.
            <span
              ref={measureChip}
              className="absolute start-2.5 top-2 flex h-lh max-w-1/2 items-center gap-1 rounded-md bg-syntax-token/12 px-1.5 indent-0 font-medium text-syntax-token"
            >
              <SkillIcon className="size-3.5 shrink-0" />
              <span className="truncate">{skill.command.name}</span>
            </span>
          )}
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
          aria-describedby={skill ? skillId : undefined}
          value={text}
          onChange={(event) => {
            const next = chipToken + event.target.value
            // The space that ends a skill's name moves the name into the chip.
            if (leadingSkill(next, commands)?.token !== skill?.token) {
              replace(next, chipToken.length + event.target.selectionStart)
              return
            }
            onValueChange(next)
            setCaret(event.target.selectionStart)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onScroll={(event) => {
            if (highlightRef.current) highlightRef.current.scrollTop = event.currentTarget.scrollTop
          }}
          onKeyDown={handleKeyDown}
          placeholder={skill ? skill.command.argumentHint : placeholder}
          className={cn(
            textLayout,
            skill && afterChip,
            "field-sizing-content min-h-0 w-full resize-none bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
            className,
          )}
          {...props}
        />
      </div>
      {skill && (
        <span id={skillId} hidden>
          {m.composer_skill({ name: skill.command.name })}
        </span>
      )}
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
  const isSkill = command.builtin !== true
  return (
    <>
      {isSkill ? (
        <SkillIcon className="size-3.5 shrink-0 self-center text-syntax-token" />
      ) : (
        <RiSlashCommands2 aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" />
      )}
      <span className={cn("shrink-0 font-mono", isSkill && "text-syntax-token")}>{suggestion.insert}</span>
      {command.argumentHint !== "" && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{command.argumentHint}</span>
      )}
      <span className="min-w-0 truncate text-xs text-muted-foreground">{command.description}</span>
    </>
  )
}
