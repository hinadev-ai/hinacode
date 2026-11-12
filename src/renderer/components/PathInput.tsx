import { Autocomplete } from "@base-ui/react/autocomplete"
import { useAtomValue } from "@effect/atom-react"
import { FolderIcon } from "@hinacode/icons"
import { AsyncResult } from "effect/reactivity"
import { startTransition, useRef, useState } from "react"
import { RiGitRepositoryLine } from "react-icons/ri"
import { looksLikeDirectoryPath, separatorOf } from "../../shared/directoryPath.ts"
import type { DirectorySuggestion } from "../../shared/domain.ts"
import { directorySuggestionsAtom, type EnvironmentId } from "../lib/rpc.ts"
import { useDebouncedValue } from "../lib/useDebouncedValue.ts"
import { m } from "../paraglide/messages.js"
import { Input } from "./ui/input.tsx"

const DEBOUNCE_MS = 80

const none: ReadonlyArray<DirectorySuggestion> = []

const completionOf = (suggestion: DirectorySuggestion) =>
  suggestion.repository ? suggestion.path : `${suggestion.path}${separatorOf(suggestion.path)}`

const endsWithSeparator = (path: string) => path.endsWith("/") || path.endsWith("\\")

function useDirectorySuggestions(environment: EnvironmentId, query: string): ReadonlyArray<DirectorySuggestion> {
  const settled = useDebouncedValue(query, DEBOUNCE_MS)
  const result = useAtomValue(directorySuggestionsAtom(environment, settled))
  const answer = AsyncResult.isSuccess(result) ? result.value : null
  const [last, setLast] = useState({ environment, suggestions: none })
  if (answer !== null && (answer !== last.suggestions || environment !== last.environment))
    setLast({ environment, suggestions: answer })
  if (!looksLikeDirectoryPath(query)) return none
  if (settled === query && answer !== null) return answer
  const previous = last.environment === environment ? last.suggestions : none
  const needle = query.toLowerCase()
  return previous.filter((suggestion) => suggestion.path.toLowerCase().startsWith(needle))
}

interface PathInputProps {
  readonly id: string
  readonly value: string
  readonly onChange: (path: string) => void
  readonly environment: EnvironmentId
  readonly placeholder?: string
  readonly required?: boolean
  readonly className?: string
}

export function PathInput({ id, value, onChange, environment, placeholder, required, className }: PathInputProps) {
  const suggestions = useDirectorySuggestions(environment, value)
  const [open, setOpen] = useState(false)
  const highlighted = useRef<DirectorySuggestion | undefined>(undefined)
  const showing = open && suggestions.length > 0

  const accept = (suggestion: DirectorySuggestion) => {
    onChange(completionOf(suggestion))
    setOpen(!suggestion.repository)
  }

  return (
    <Autocomplete.Root
      items={suggestions}
      filter={null}
      value={value}
      onValueChange={(next, details) => {
        // FIXME: Base UI clears the field on Escape while the list is closed
        if (details.reason === "escape-key") return
        onChange(next)
        if (details.reason === "item-press") startTransition(() => setOpen(endsWithSeparator(next)))
      }}
      open={showing}
      onOpenChange={(next, details) => {
        if (details.reason !== "item-press") setOpen(next)
      }}
      onItemHighlighted={(item) => {
        highlighted.current = item
      }}
      openOnInputClick
      itemToStringValue={completionOf}
    >
      <Autocomplete.Input
        id={id}
        required={required}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.shiftKey || !showing) return
          const pick = suggestions.find((suggestion) => suggestion.path === highlighted.current?.path) ?? suggestions[0]
          if (!pick || completionOf(pick) === value) return
          event.preventDefault()
          accept(pick)
        }}
        render={<Input className={className} />}
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner align="start" sideOffset={4} collisionPadding={8} className="isolate z-50">
          <Autocomplete.Popup className="max-h-[min(20rem,var(--available-height))] w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-97 data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-97 data-starting-style:opacity-0 motion-reduce:transition-none">
            <Autocomplete.List aria-label={m.path_input_suggestions()} className="scroll-py-1">
              {(suggestion: DirectorySuggestion) => <SuggestionItem key={suggestion.path} suggestion={suggestion} />}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  )
}

function SuggestionItem({ suggestion }: { suggestion: DirectorySuggestion }) {
  return (
    <Autocomplete.Item
      value={suggestion}
      className="flex h-7 cursor-default [scroll-margin-block:0.25rem] items-center gap-2 rounded-sm px-2 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
    >
      {suggestion.repository ? (
        <RiGitRepositoryLine aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{suggestion.name}</span>
      {suggestion.repository && <span className="sr-only">{m.path_input_repository()}</span>}
    </Autocomplete.Item>
  )
}
