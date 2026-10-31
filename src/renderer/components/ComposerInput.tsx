// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events -- the WAI-ARIA combobox pattern: a textarea driving a listbox through aria-activedescendant, which <datalist> cannot do. Keys reach the options through the textarea.
import { type ComponentProps, type KeyboardEvent, type Ref, useId, useImperativeHandle, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { AgentCommand } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import type { MentionableThreads } from "../../shared/threadMention.ts"
import {
  completionAt,
  type CompletionQuery,
  type Fence,
  fenceCode,
  highlight,
  leadingSkill,
  type Suggestion,
  suggestionsFor,
  type SyntaxKind,
} from "../../shared/composerSyntax.ts"
import { usePullRequestSearch } from "../lib/usePullRequestSearch.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { HighlightedCode } from "./HighlightedCode.tsx"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SkillIcon } from "./icons/SkillIcon.tsx"
import { StatusIcon } from "./ThreadPullRequests.tsx"
import { FileIcon } from "./icons/FileIcon.tsx"
import { SlashIcon } from "./icons/SlashIcon.tsx"

const syntaxClass: Record<SyntaxKind, string> = {
  text: "text-foreground",
  bullet: "text-muted-foreground",
  code: "rounded-sm bg-muted text-foreground",
  command: "text-syntax-token",
  mention: "text-syntax-token",
}

const textLayout =
  "col-start-1 row-start-1 max-h-60 px-2.5 py-2 text-base whitespace-pre-wrap [overflow-wrap:break-word] [scrollbar-gutter:stable] md:text-sm"

// FIXME: browsers drop the line after a trailing newline in the highlighted copy, but not in the textarea
const TRAILING_LINE = "\u200b"

const scrollIntoViewNearest = (option: HTMLElement | null) => option?.scrollIntoView({ block: "nearest" })

const afterChip = "indent-[calc(var(--skill-chip-width)_+_--spacing(1.5))]"

interface ComposerInputProps extends Omit<ComponentProps<"textarea">, "value" | "onChange" | "ref"> {
  readonly ref?: Ref<HTMLTextAreaElement>
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly commands: ReadonlyArray<AgentCommand>
  readonly files: ReadonlyArray<string>
  readonly threads: MentionableThreads<Thread>
  readonly projectId: string
}

export function ComposerInput({
  ref,
  value,
  onValueChange,
  commands,
  files,
  threads,
  projectId,
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
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState({ start: -1, index: 0 })
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  useImperativeHandle(ref, () => textareaRef.current!, [])

  const known = {
    commands: new Set(commands.map((command) => command.trigger + command.name)),
    files: new Set(files),
    threads: new Set([...threads.sameMachine, ...threads.otherMachines].map((thread) => thread.id)),
  }
  const skill = leadingSkill(value, commands)
  const chipToken = skill?.token ?? ""
  const text = value.slice(chipToken.length)
  const segments = highlight(text, known)

  const completion = completionAt(text, caret)
  const active = completion && completion.start !== dismissedAt ? completion : null
  const pullRequests = usePullRequestSearch(projectId, active?.trigger === "#" ? active.query : null)
  const suggestions = active ? suggestionsFor(active, commands, files, threads, pullRequests) : []
  const open = completion !== null && suggestions.length > 0
  const activeIndex = completion?.start === selected.start ? Math.min(selected.index, suggestions.length - 1) : 0
  const optionId = (index: number) => `${listId}-${index}`

  // FIXME: React attaches a child's ref before its parent's, so the observer reads layersRef when it fires
  const measureChip = (element: HTMLElement | null) => {
    if (element === null) return
    const observer = new ResizeObserver(() =>
      layersRef.current?.style.setProperty("--skill-chip-width", `${element.offsetWidth}px`),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }

  // FIXME: rendering a new value moves the textarea's caret to its end, so render now and put the caret back
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
            <span
              ref={measureChip}
              className="absolute start-2.5 top-2 flex h-lh max-w-1/2 items-center gap-1 rounded-md bg-syntax-token/12 px-1.5 indent-0 font-medium text-syntax-token"
            >
              <SkillIcon className="size-3.5 shrink-0" />
              <span className="truncate">{skill.command.name}</span>
            </span>
          )}
          {segments.map((segment, index) => {
            if (segment.kind === "fence")
              return (
                <FenceCard key={index} fence={segment} firstLine={index === 0} last={index === segments.length - 1} />
              )
            const shown = segments[index - 1]?.kind === "fence" ? segment.text.replace(/^\n/, "") : segment.text
            return (
              <span key={index} className={syntaxClass[segment.kind]}>
                {shown}
              </span>
            )
          })}
          {segments.at(-1)?.kind !== "fence" && TRAILING_LINE}
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
          aria-label={listLabel[completion.trigger]()}
          className="absolute inset-x-0 bottom-full mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.insert}
              ref={index === activeIndex ? scrollIntoViewNearest : undefined}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(suggestion)}
              onMouseMove={() => index !== activeIndex && setSelected({ start: completion.start, index })}
              className="flex cursor-default items-baseline gap-2 rounded-[9px] px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <SuggestionRow suggestion={suggestion} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function FenceCard({ fence, firstLine, last }: { fence: Fence; firstLine: boolean; last: boolean }) {
  return (
    <span className={cn("-mx-1 block rounded-md bg-muted px-1 text-foreground", !firstLine && "indent-0")}>
      <span className="text-muted-foreground">{fence.open}</span>
      {fence.lines.length > 0 && (
        <>
          {"\n"}
          <HighlightedCode code={fenceCode(fence)} language={fence.language} />
        </>
      )}
      {fence.close !== null && <span className="text-muted-foreground">{`\n${fence.close}`}</span>}
      {last && TRAILING_LINE}
    </span>
  )
}

const listLabel = {
  "@": m.composer_mentions_label,
  "#": m.composer_pull_requests_label,
  "/": m.composer_commands_label,
  $: m.composer_commands_label,
} satisfies Record<CompletionQuery["trigger"], () => string>

function commandKind(command: AgentCommand) {
  if (command.builtin === true) return m.composer_kind_command()
  if (command.scope === "user") return m.composer_kind_user_skill()
  if (command.scope === "project") return m.composer_kind_project_skill()
  return m.composer_kind_skill()
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
  if (suggestion.type === "pullRequest") {
    const { pullRequest } = suggestion
    return (
      <>
        <StatusIcon status={pullRequest.status} colored className="size-3.5 shrink-0 self-center" />
        <span className="shrink-0 font-mono text-muted-foreground">{suggestion.insert}</span>
        <span className="min-w-0 truncate">{pullRequest.title}</span>
        <span className="ms-auto shrink-0 ps-2 text-xs text-muted-foreground">{pullRequest.author}</span>
      </>
    )
  }
  if (suggestion.type === "file") {
    const slash = suggestion.path.lastIndexOf("/")
    return (
      <>
        <FileIcon aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" />
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
        <SlashIcon aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" />
      )}
      <span className={cn("shrink-0 font-mono", isSkill && "text-syntax-token")}>{suggestion.insert}</span>
      {command.argumentHint !== "" && (
        <span className="max-w-1/3 shrink-0 truncate font-mono text-xs text-muted-foreground">
          {command.argumentHint}
        </span>
      )}
      <span className="min-w-0 truncate text-xs text-muted-foreground">{command.description}</span>
      <span className="ms-auto shrink-0 ps-2 text-xs text-muted-foreground">{commandKind(command)}</span>
    </>
  )
}
