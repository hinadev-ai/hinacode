// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/click-events-have-key-events -- the WAI-ARIA combobox pattern: an editor driving a listbox through aria-activedescendant, which <datalist> cannot do. Keys reach the options through the editor.
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands"
import { Compartment, EditorState, Prec } from "@codemirror/state"
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view"
import {
  type DragEvent as ReactDragEvent,
  type Ref,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { RiFileLine, RiSlashCommands2 } from "react-icons/ri"
import type { AgentCommand } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import type { MentionableThreads } from "../../shared/threadMention.ts"
import { completionAt, type CompletionQuery, type Suggestion, suggestionsFor } from "../../shared/composerSyntax.ts"
import { useTheme } from "../lib/appearance.ts"
import { chipBefore, composerSyntax, setComposerConfig } from "../lib/composerEditor.ts"
import { useClientSettings } from "../lib/settings.ts"
import { usePullRequestSearch } from "../lib/usePullRequestSearch.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SkillIcon } from "./icons/SkillIcon.tsx"
import { StatusIcon } from "./ThreadPullRequests.tsx"

const scrollIntoViewNearest = (option: HTMLElement | null) => option?.scrollIntoView({ block: "nearest" })

export interface ComposerInputHandle {
  focus(): void
}

interface ComposerInputProps {
  readonly ref?: Ref<ComposerInputHandle>
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly commands: ReadonlyArray<AgentCommand>
  readonly files: ReadonlyArray<string>
  readonly threads: MentionableThreads<Thread>
  readonly projectId: string
  readonly placeholder: string
  readonly "aria-label": string
  readonly onEnter: (event: KeyboardEvent) => void
  readonly onPaste?: (event: ClipboardEvent) => void
  readonly onDrop?: (event: DragEvent) => void
  readonly onDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void
}

export function ComposerInput({
  ref,
  value,
  onValueChange,
  commands,
  files,
  threads,
  projectId,
  placeholder,
  "aria-label": label,
  onEnter,
  onPaste,
  onDrop,
  onDragOver,
}: ComposerInputProps) {
  const listId = useId()
  const parentRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [attributes] = useState(() => new Compartment())
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState({ start: -1, index: 0 })
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const { codeTheme, scheme } = useTheme(useClientSettings().appearance.theme)

  const completion = completionAt(value, caret)
  const active = completion && completion.start !== dismissedAt ? completion : null
  const pullRequests = usePullRequestSearch(projectId, active?.trigger === "#" ? active.query : null)
  const suggestions = active ? suggestionsFor(active, commands, files, threads, pullRequests) : []
  const open = completion !== null && suggestions.length > 0
  const activeIndex = completion?.start === selected.start ? Math.min(selected.index, suggestions.length - 1) : 0
  const optionId = (index: number) => `${listId}-${index}`

  const pick = (suggestion: Suggestion) => {
    const view = viewRef.current
    if (view === null || completion === null) return
    const insert = `${suggestion.insert} `
    const to = completion.end + (value[completion.end] === " " ? 1 : 0)
    view.dispatch({
      changes: { from: completion.start, to, insert },
      selection: { anchor: completion.start + insert.length },
    })
    view.focus()
    setDismissedAt(null)
  }

  const move = (step: 1 | -1) =>
    setSelected({
      start: completion?.start ?? -1,
      index: (activeIndex + step + suggestions.length) % suggestions.length,
    })

  const keyDown = useEffectEvent((event: KeyboardEvent, view: EditorView) => {
    if (event.isComposing) return false
    const suggestion = suggestions[activeIndex]
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      move(event.key === "ArrowDown" ? 1 : -1)
      return true
    }
    if (open && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey && suggestion) {
      pick(suggestion)
      return true
    }
    if (open && event.key === "Escape") {
      event.stopPropagation()
      setDismissedAt(completion.start)
      return true
    }
    const { main } = view.state.selection
    const chip = main.empty ? chipBefore(view, main.head) : null
    if (event.key === "Backspace" && chip !== null) {
      const spaceAfter = view.state.sliceDoc(chip.to, chip.to + 1) === " " ? 1 : 0
      view.dispatch({ changes: { from: chip.from, to: chip.to + spaceAfter } })
      return true
    }
    if (event.key !== "Enter") return false
    if (event.shiftKey) insertNewline(view)
    else onEnter(event)
    return true
  })

  const changed = useEffectEvent((update: ViewUpdate) => {
    const text = update.state.doc.toString()
    if (update.docChanged && text !== value) onValueChange(text)
    if (update.docChanged || update.selectionSet) setCaret(update.state.selection.main.head)
  })
  const pasted = useEffectEvent((event: ClipboardEvent) => onPaste?.(event))
  const dropped = useEffectEvent((event: DragEvent) => onDrop?.(event))
  const initialText = useEffectEvent(() => value)

  useEffect(() => {
    const view = new EditorView({
      parent: parentRef.current!,
      state: EditorState.create({
        doc: initialText(),
        extensions: [
          history(),
          composerSyntax,
          attributes.of([]),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event, editor) => {
                const handled = keyDown(event, editor)
                if (handled) event.preventDefault()
                return handled
              },
              paste: (event) => {
                pasted(event)
                return event.defaultPrevented
              },
              drop: (event) => {
                dropped(event)
                return event.defaultPrevented
              },
            }),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of(changed),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [attributes])
  useImperativeHandle(ref, () => ({ focus: () => viewRef.current?.focus() }), [])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: value.length },
    })
  })

  const contentAttributes: Record<string, string> = {
    role: "combobox",
    "aria-label": label,
    "aria-placeholder": placeholder,
    "aria-autocomplete": "list",
    "aria-expanded": String(open),
    ...(open ? { "aria-controls": listId, "aria-activedescendant": optionId(activeIndex) } : {}),
  }
  const attributesKey = JSON.stringify(contentAttributes)
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    setComposerConfig(view, {
      commands,
      files,
      threadIds: [...threads.sameMachine, ...threads.otherMachines].map((thread) => thread.id),
      placeholder,
      codeTheme,
      scheme,
    })
  })
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: attributes.reconfigure(Prec.highest(EditorView.contentAttributes.of(JSON.parse(attributesKey)))),
    })
  }, [attributes, attributesKey])

  return (
    <>
      <div
        ref={parentRef}
        onDragOver={onDragOver}
        className="flex min-h-0 flex-col text-base md:text-sm [&_.cm-editor]:min-h-0"
      />
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
              id={optionId(index)}
              ref={index === activeIndex ? scrollIntoViewNearest : undefined}
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
        <span className="max-w-1/3 shrink-0 truncate font-mono text-xs text-muted-foreground">
          {command.argumentHint}
        </span>
      )}
      <span className="min-w-0 truncate text-xs text-muted-foreground">{command.description}</span>
      <span className="ms-auto shrink-0 ps-2 text-xs text-muted-foreground">{commandKind(command)}</span>
    </>
  )
}
