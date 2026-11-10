import { cn } from "cn"
import { startTransition } from "react"
import { isCronExpression, type RoutineSchedule } from "../../../../shared/domain.ts"
import { useNow } from "../../../lib/useNow.ts"
import { m } from "../../../paraglide/messages.js"
import { getLocale } from "../../../paraglide/runtime.js"
import { FieldError } from "../../ui/field.tsx"
import { Input } from "../../ui/input.tsx"
import { Label } from "../../ui/label.tsx"
import { Tabs, TabsList, TabsTrigger } from "../../ui/tabs.tsx"
import {
  type DaySlot,
  type Repeat,
  repeats,
  type ScheduleDraft,
  RUNS_COUNTED_PER_DAY,
  toCron,
  weekAhead,
  weekdayName,
} from "./schedule.ts"

const repeatLabel = {
  none: m.routines_repeat_none,
  hourly: m.routines_repeat_hourly,
  daily: m.routines_repeat_daily,
  weekdays: m.routines_repeat_weekdays,
  weekly: m.routines_repeat_weekly,
  custom: m.routines_repeat_custom,
} satisfies Record<Repeat, () => string>

const presetOrder: ReadonlyArray<Repeat> = ["hourly", "daily", "weekdays", "weekly", "custom", "none"]

const isRepeat = (value: unknown): value is Repeat => repeats.some((repeat) => repeat === value)

const pad = (value: number) => String(value).padStart(2, "0")

const clockIn = (date: Date, timeZone: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date)

interface SchedulePickerProps {
  readonly value: ScheduleDraft
  readonly timezone: string
  readonly onChange: (value: ScheduleDraft) => void
}

export function SchedulePicker({ value, timezone, onChange }: SchedulePickerProps) {
  const patch = (next: Partial<ScheduleDraft>) => onChange({ ...value, ...next })
  const changeRepeat = (repeat: Repeat) =>
    patch(repeat === "custom" ? { repeat, cron: toCron(value) ?? value.cron } : { repeat })
  const toggleDay = (day: number) =>
    startTransition(() =>
      patch({ days: value.days.includes(day) ? value.days.filter((other) => other !== day) : [...value.days, day] }),
    )
  const cron = toCron(value)
  const invalid = cron !== null && !isCronExpression(cron, timezone)

  return (
    <div className="flex flex-col gap-2.5">
      <Tabs value={value.repeat} onValueChange={(next) => isRepeat(next) && changeRepeat(next)}>
        <TabsList aria-label={m.routines_repeat_label()} className="w-full">
          {presetOrder.map((repeat) => (
            <TabsTrigger key={repeat} value={repeat} className="text-xs">
              {repeatLabel[repeat]()}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {cron !== null && !invalid && (
        <WeekStrip
          schedule={{ cron, timezone }}
          days={value.repeat === "weekly" ? value.days : null}
          onToggleDay={toggleDay}
        />
      )}
      {value.repeat !== "none" && (
        <div className="flex items-center gap-2">
          {value.repeat === "hourly" && (
            <>
              <Label htmlFor="routine-minute" className="font-normal text-muted-foreground">
                {m.routines_minute_label()}
              </Label>
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
                className="h-8 w-16 font-mono tabular-nums"
              />
            </>
          )}
          {(value.repeat === "daily" || value.repeat === "weekdays" || value.repeat === "weekly") && (
            <>
              <Label htmlFor="routine-time" className="font-normal text-muted-foreground">
                {m.routines_time_label()}
              </Label>
              <Input
                id="routine-time"
                type="time"
                required
                value={`${pad(value.hour)}:${pad(value.minute)}`}
                onChange={(event) => {
                  const [hour, minute] = event.target.value.split(":").map(Number)
                  if (hour !== undefined && minute !== undefined && !Number.isNaN(hour + minute))
                    patch({ hour, minute })
                }}
                className="h-8 w-32 tabular-nums"
              />
            </>
          )}
          {value.repeat === "custom" && (
            <>
              <Label htmlFor="routine-cron" className="shrink-0 font-normal text-muted-foreground">
                {m.routines_cron_label()}
              </Label>
              <Input
                id="routine-cron"
                required
                value={value.cron}
                onChange={(event) => patch({ cron: event.target.value })}
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={invalid || undefined}
                className="h-8 min-w-0 flex-1 font-mono"
              />
            </>
          )}
          <span className="ms-auto shrink-0 text-xs text-muted-foreground">{timezone}</span>
        </div>
      )}
      {invalid && <FieldError>{m.routines_cron_invalid()}</FieldError>}
    </div>
  )
}

interface WeekStripProps {
  readonly schedule: RoutineSchedule
  readonly days: ReadonlyArray<number> | null
  readonly onToggleDay: (day: number) => void
}

function WeekStrip({ schedule, days, onToggleDay }: WeekStripProps) {
  const locale = getLocale()
  const now = useNow()
  const slots = weekAhead(schedule, new Date(now))
  const next = slots.find((slot) => slot.count > 0)

  return (
    <ol
      aria-label={days === null ? m.routines_next_runs({ timezone: schedule.timezone }) : m.routines_days_label()}
      className="grid grid-cols-7 gap-1.5"
    >
      {slots.map((slot) => {
        const on = days === null ? slot.count > 0 : days.includes(slot.weekday)
        const className = cn(
          "flex w-full flex-col items-center gap-0.5 rounded-lg border py-2 tabular-nums",
          on ? "border-input bg-background" : "border-dashed border-input text-muted-foreground",
          slot === next && "border-primary bg-primary/10",
        )
        const content = <DayCell slot={slot} next={slot === next} timezone={schedule.timezone} locale={locale} />
        if (days === null)
          return (
            <li key={slot.key} className={className}>
              {content}
            </li>
          )
        return (
          <li key={slot.key}>
            <button
              type="button"
              aria-pressed={on}
              aria-label={weekdayName(slot.weekday, locale, "long")}
              disabled={on && days.length === 1}
              onClick={() => onToggleDay(slot.weekday)}
              className={cn(
                className,
                "transition-colors outline-none hover:border-ring focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed",
              )}
            >
              {content}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

interface DayCellProps {
  readonly slot: DaySlot
  readonly next: boolean
  readonly timezone: string
  readonly locale: string
}

function DayCell({ slot, next, timezone, locale }: DayCellProps) {
  const { first, count } = slot
  return (
    <>
      <span className="text-xs text-muted-foreground">{weekdayName(slot.weekday, locale)}</span>
      <span className="text-sm font-semibold">{slot.day}</span>
      {first === undefined ? (
        <span aria-hidden className="font-mono text-xs">
          –
        </span>
      ) : (
        <span className={cn("font-mono text-xs", next ? "text-primary" : "text-muted-foreground")}>
          <time dateTime={first.toISOString()}>{clockIn(first, timezone, locale)}</time>
          {count > 1 && ` +${count - 1}${count === RUNS_COUNTED_PER_DAY ? "+" : ""}`}
        </span>
      )}
    </>
  )
}
