import { en, ja, zh } from "chrono-node"
import type { Locale } from "../../shared/domain.ts"
import { MORNING } from "./snooze.ts"

export type ParsedSnooze =
  | { readonly status: "empty" | "unreadable" }
  | { readonly status: "ok" | "past"; readonly at: Date }

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
