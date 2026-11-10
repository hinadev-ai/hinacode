import { isCronExpression } from "../../../../shared/domain.ts"
import { useNow } from "../../../lib/useNow.ts"
import { m } from "../../../paraglide/messages.js"
import { getLocale } from "../../../paraglide/runtime.js"
import { Field, FieldError, FieldLabel } from "../../ui/field.tsx"
import { Input } from "../../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select.tsx"
import { type Repeat, repeats, type ScheduleDraft, toCron, weekdayName, weekdays, nextRuns } from "./schedule.ts"
import { formatTime } from "./shared.tsx"

const repeatLabel = {
  none: m.routines_repeat_none,
  hourly: m.routines_repeat_hourly,
  daily: m.routines_repeat_daily,
  weekdays: m.routines_repeat_weekdays,
  weekly: m.routines_repeat_weekly,
  custom: m.routines_repeat_custom,
} satisfies Record<Repeat, () => string>

const isRepeat = (value: unknown): value is Repeat => repeats.some((repeat) => repeat === value)

const pad = (value: number) => String(value).padStart(2, "0")

interface SchedulePickerProps {
  readonly value: ScheduleDraft
  readonly timezone: string
  readonly onChange: (value: ScheduleDraft) => void
}

export function SchedulePicker({ value, timezone, onChange }: SchedulePickerProps) {
  const locale = getLocale()
  const items = repeats.map((repeat) => ({ value: repeat, label: repeatLabel[repeat]() }))
  const patch = (next: Partial<ScheduleDraft>) => onChange({ ...value, ...next })
  const changeRepeat = (repeat: Repeat) =>
    patch(repeat === "custom" ? { repeat, cron: toCron(value) ?? value.cron } : { repeat })
  const cron = toCron(value)
  const invalid = cron !== null && !isCronExpression(cron, timezone)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-44">
          <FieldLabel htmlFor="routine-repeat">{m.routines_repeat_label()}</FieldLabel>
          <Select items={items} value={value.repeat} onValueChange={(next) => isRepeat(next) && changeRepeat(next)}>
            <SelectTrigger id="routine-repeat" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {value.repeat === "hourly" && (
          <Field className="w-24">
            <FieldLabel htmlFor="routine-minute">{m.routines_minute_label()}</FieldLabel>
            <Input
              id="routine-minute"
              type="number"
              min={0}
              max={59}
              required
              value={value.minute}
              onChange={(event) =>
                patch({ minute: Math.min(59, Math.max(0, Math.trunc(event.target.valueAsNumber || 0))) })
              }
              className="font-mono tabular-nums"
            />
          </Field>
        )}
        {(value.repeat === "daily" || value.repeat === "weekdays" || value.repeat === "weekly") && (
          <Field className="w-32">
            <FieldLabel htmlFor="routine-time">{m.routines_time_label()}</FieldLabel>
            <Input
              id="routine-time"
              type="time"
              required
              value={`${pad(value.hour)}:${pad(value.minute)}`}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(":").map(Number)
                if (hour !== undefined && minute !== undefined && !Number.isNaN(hour + minute)) patch({ hour, minute })
              }}
              className="tabular-nums"
            />
          </Field>
        )}
        {value.repeat === "custom" && (
          <Field className="min-w-48 flex-1">
            <FieldLabel htmlFor="routine-cron">{m.routines_cron_label()}</FieldLabel>
            <Input
              id="routine-cron"
              required
              value={value.cron}
              onChange={(event) => patch({ cron: event.target.value })}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalid || undefined}
              className="font-mono"
            />
          </Field>
        )}
      </div>
      {value.repeat === "weekly" && (
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{m.routines_days_label()}</legend>
          {weekdays.map((day) => {
            const on = value.days.includes(day)
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                aria-label={weekdayName(day, locale, "long")}
                disabled={on && value.days.length === 1}
                onClick={() => patch({ days: on ? value.days.filter((other) => other !== day) : [...value.days, day] })}
                className="h-7 min-w-11 rounded-lg border border-input px-2 text-xs font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed aria-pressed:border-transparent aria-pressed:bg-primary aria-pressed:text-primary-foreground"
              >
                {weekdayName(day, locale)}
              </button>
            )
          })}
        </fieldset>
      )}
      {invalid ? (
        <FieldError>{m.routines_cron_invalid()}</FieldError>
      ) : (
        cron !== null && <NextRuns cron={cron} timezone={timezone} />
      )}
    </div>
  )
}

function NextRuns({ cron, timezone }: { cron: string; timezone: string }) {
  const now = useNow()
  const runs = nextRuns({ cron, timezone }, new Date(now), 3)
  return (
    <section aria-label={m.routines_next_runs({ timezone })} className="flex flex-col gap-1 text-xs">
      <h4 className="text-muted-foreground">{m.routines_next_runs({ timezone })}</h4>
      <ul className="flex flex-col gap-0.5 tabular-nums">
        {runs.map((run) => (
          <li key={run.toISOString()}>
            <time dateTime={run.toISOString()}>{formatTime(run, timezone)}</time>
          </li>
        ))}
      </ul>
    </section>
  )
}
