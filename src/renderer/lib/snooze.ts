import { en, ja, zh } from "chrono-node"
import type { Locale } from "../../shared/domain.ts"

export type SnoozePresetId = "inAnHour" | "thisEvening" | "tomorrow" | "nextWeek"

export interface SnoozePreset {
  readonly id: SnoozePresetId
  readonly at: Date
}

export type ParsedSnooze =
  | { readonly status: "empty" | "unreadable" }
  | { readonly status: "ok" | "past"; readonly at: Date }

const MORNING = 9
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

// People type English times whatever language the app shows, so every locale falls back to it.
const parsers: Record<Locale, ReadonlyArray<typeof en.casual>> = {
  en: [en.casual],
  ja: [ja.casual, en.casual],
  "zh-TW": [zh.hant.casual, en.casual],
}

/** Reads a typed time such as "monday 8:00" or "in 2 hours" from `now`. A day without a time means 9:00. */
export function parseSnoozeTime(text: string, now: Date, locale: Locale): ParsedSnooze {
  if (text.trim() === "") return { status: "empty" }
  for (const parser of parsers[locale]) {
    const [result] = parser.parse(text, now, { forwardDate: true })
    if (!result) continue
    const date = result.start.date()
    // chrono puts a bare day at noon. "tonight" and "in 2 days" imply other hours, which stay.
    if (!result.start.isCertain("hour") && date.getHours() === 12) date.setHours(MORNING, 0, 0, 0)
    // chrono reads a bare weekday as today until noon, so its 9:00 can already be past. It means next week's then.
    if (date <= now && result.start.isCertain("weekday") && !result.start.isCertain("day"))
      date.setDate(date.getDate() + 7)
    return { status: date.getTime() > now.getTime() ? "ok" : "past", at: date }
  }
  return { status: "unreadable" }
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
