import { Autocomplete } from "@base-ui/react/autocomplete"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useId, useRef, useState } from "react"
import { parseSnoozeTime } from "../lib/parseSnoozeTime.ts"
import { formatSnoozeTime, type SnoozePresetId, snoozePresets } from "../lib/snooze.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { CalendarIcon } from "./icons/CalendarIcon.tsx"
import type { IconComponent } from "./icons/Icon.tsx"

export interface TimeChoice {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly at: Date | null
  readonly icon?: IconComponent
}

export interface TimePickerProps {
  readonly title: string
  readonly inputLabel: string
  readonly placeholder: string
  readonly icon: IconComponent
  readonly extraChoices?: (now: Date) => ReadonlyArray<TimeChoice>
  readonly onChoose: (at: Date | null) => void
  readonly onClose: () => void
}

const focusOnMount = (input: HTMLInputElement | null) => input?.focus()

const presetLabels: Record<SnoozePresetId, () => string> = {
  inAnHour: m.snooze_in_an_hour,
  thisEvening: m.snooze_this_evening,
  tomorrow: m.snooze_tomorrow,
  nextWeek: m.snooze_next_week,
}

export default function TimePicker({
  title,
  inputLabel,
  placeholder,
  icon: InputIcon,
  extraChoices,
  onChoose,
  onClose,
}: TimePickerProps) {
  const [text, setText] = useState("")
  const problemId = useId()
  const browsed = useRef(false)
  const now = new Date(useNow())
  const locale = getLocale()
  const parsed = parseSnoozeTime(text, now, locale)

  const choices: ReadonlyArray<TimeChoice> = [
    ...(parsed.status === "ok"
      ? [
          {
            id: "typed",
            label: parsed.at.toLocaleString(locale, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
            hint: m.snooze_typed(),
            at: parsed.at,
            icon: CalendarIcon,
          },
        ]
      : []),
    ...snoozePresets(now).map((preset) => ({
      id: preset.id,
      label: presetLabels[preset.id](),
      hint: formatSnoozeTime(preset.at, now, locale),
      at: preset.at,
    })),
    ...(extraChoices?.(now) ?? []),
  ]
  const problem =
    parsed.status === "unreadable" ? m.snooze_unreadable() : parsed.status === "past" ? m.snooze_past() : ""

  return (
    <>
      <DialogPrimitive.Title className="truncate px-3.5 pt-3 text-xs text-muted-foreground">
        {title}
      </DialogPrimitive.Title>
      <Autocomplete.Root
        open
        inline
        items={choices}
        filter={null}
        autoHighlight={problem === "" ? "always" : false}
        keepHighlight
        value={text}
        onValueChange={(value, details) => {
          if (details.reason !== "item-press") setText(value)
          browsed.current = false
        }}
        onItemHighlighted={(_, details) => {
          browsed.current = details.reason === "keyboard"
        }}
        itemToStringValue={(choice: TimeChoice) => choice.label}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <InputIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Autocomplete.Input
            ref={focusOnMount}
            aria-label={inputLabel}
            aria-describedby={problemId}
            placeholder={placeholder}
            onKeyDown={(event) => {
              // FIXME: Base UI's always-open list takes Escape for itself and keeps the dialog up
              if (event.key === "Escape") onClose()
              if (event.key === "Enter" && problem !== "" && !browsed.current) event.preventBaseUIHandler()
            }}
            className="h-12 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <output id={problemId} className="block px-3.5 pt-2 text-xs text-muted-foreground empty:hidden">
          {problem}
        </output>
        <Autocomplete.List className="min-h-0 scroll-py-1 overflow-y-auto overscroll-contain p-1.5">
          {(choice: TimeChoice) => (
            <Autocomplete.Item
              key={choice.id}
              value={choice}
              onClick={() => onChoose(choice.at)}
              className="flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:inset-ring data-highlighted:inset-ring-ring/50"
            >
              {choice.icon ? (
                <choice.icon aria-hidden className="size-4 shrink-0" />
              ) : (
                <span aria-hidden className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{choice.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{choice.hint}</span>
            </Autocomplete.Item>
          )}
        </Autocomplete.List>
      </Autocomplete.Root>
    </>
  )
}
