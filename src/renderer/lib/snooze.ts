export type SnoozePresetId = "inAnHour" | "thisEvening" | "tomorrow" | "nextWeek"

export interface SnoozePreset {
  readonly id: SnoozePresetId
  readonly at: Date
}

/** The hour a snooze without a time of day wakes at. */
export const MORNING = 9
const EVENING = 18
const HOUR_MS = 60 * 60 * 1000

const at = (day: Date, hour: number, daysLater = 0) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + daysLater, hour)

/** The fixed snooze times from `now`, soonest first. One that lands on another's time is left out. */
export function snoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS)
  inAnHour.setSeconds(0, 0)
  const daysToMonday = (8 - now.getDay()) % 7 || 7
  const presets: ReadonlyArray<SnoozePreset> = [
    { id: "inAnHour", at: inAnHour },
    // An evening an hour or less away is what "In 1 hour" already offers.
    ...(at(now, EVENING).getTime() - now.getTime() > HOUR_MS
      ? [{ id: "thisEvening" as const, at: at(now, EVENING) }]
      : []),
    { id: "tomorrow", at: at(now, MORNING, 1) },
    { id: "nextWeek", at: at(now, MORNING, daysToMonday) },
  ]
  return presets.filter(
    (preset, index) => presets.findIndex((other) => other.at.getTime() === preset.at.getTime()) === index,
  )
}

const DAY_MS = 24 * HOUR_MS
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

/** A wake time as short as it can be read: "18:00" today, "Mon 8:00" this week, "Nov 12, 8:00" later. */
export function formatSnoozeTime(time: Date, now: Date, locale: string): string {
  const clock = { hour: "numeric", minute: "2-digit" } as const
  if (sameDay(time, now)) return time.toLocaleTimeString(locale, clock)
  if (time.getTime() - now.getTime() < 6 * DAY_MS) return time.toLocaleString(locale, { weekday: "short", ...clock })
  return time.toLocaleString(locale, { month: "short", day: "numeric", ...clock })
}
