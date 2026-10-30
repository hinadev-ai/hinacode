import { Autocomplete } from "@base-ui/react/autocomplete"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useId, useRef, useState } from "react"
import { RiAlarmLine, RiAlarmSnoozeLine, RiCalendarLine } from "react-icons/ri"
import type { Thread } from "../../shared/domain.ts"
import { parseSnoozeTime } from "../lib/parseSnoozeTime.ts"
import { formatSnoozeTime, type SnoozePresetId, snoozePresets } from "../lib/snooze.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"

interface Choice {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly until: Date | null
}

const focusOnMount = (input: HTMLInputElement | null) => input?.focus()

const presetLabels: Record<SnoozePresetId, () => string> = {
  inAnHour: m.snooze_in_an_hour,
  thisEvening: m.snooze_this_evening,
  tomorrow: m.snooze_tomorrow,
  nextWeek: m.snooze_next_week,
}

interface SnoozePickerProps {
  readonly thread: Thread
  readonly onChoose: (until: Date | null) => void
  readonly onClose: () => void
}

export default function SnoozePicker({ thread, onChoose, onClose }: SnoozePickerProps) {
  const [text, setText] = useState("")
  const problemId = useId()
  const browsed = useRef(false)
  const now = new Date(useNow())
  const locale = getLocale()
  const parsed = parseSnoozeTime(text, now, locale)
  const snoozed = thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now.getTime()

  const choices: ReadonlyArray<Choice> = [
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
            until: parsed.at,
          },
        ]
      : []),
    ...snoozePresets(now).map((preset) => ({
      id: preset.id,
      label: presetLabels[preset.id](),
      hint: formatSnoozeTime(preset.at, now, locale),
      until: preset.at,
    })),
    ...(snoozed ? [{ id: "wake", label: m.sidebar_thread_unsnooze(), hint: "", until: null }] : []),
  ]
  const problem =
    parsed.status === "unreadable" ? m.snooze_unreadable() : parsed.status === "past" ? m.snooze_past() : ""

  return (
    <>
      <DialogPrimitive.Title className="truncate px-3.5 pt-3 text-xs text-muted-foreground">
        {m.snooze_label({ title: thread.title })}
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
        itemToStringValue={(choice: Choice) => choice.label}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <RiAlarmSnoozeLine aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Autocomplete.Input
            ref={focusOnMount}
            aria-label={m.snooze_input_label()}
            aria-describedby={problemId}
            placeholder={m.snooze_placeholder()}
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
          {(choice: Choice) => (
            <Autocomplete.Item
              key={choice.id}
              value={choice}
              onClick={() => onChoose(choice.until)}
              className="flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:inset-ring data-highlighted:inset-ring-ring/50"
            >
              {choice.id === "typed" ? (
                <RiCalendarLine aria-hidden className="size-4 shrink-0" />
              ) : choice.until === null ? (
                <RiAlarmLine aria-hidden className="size-4 shrink-0" />
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
