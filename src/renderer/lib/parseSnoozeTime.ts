import { en, ja, zh } from "chrono-node"
import type { Locale } from "../../shared/domain.ts"
import { MORNING } from "./snooze.ts"

export type ParsedSnooze =
  | { readonly status: "empty" | "unreadable" }
  | { readonly status: "ok" | "past"; readonly at: Date }

const parsers: Record<Locale, ReadonlyArray<typeof en.casual>> = {
  en: [en.casual],
  ja: [ja.casual, en.casual],
  "zh-TW": [zh.hant.casual, en.casual],
}

export function parseSnoozeTime(text: string, now: Date, locale: Locale): ParsedSnooze {
  if (text.trim() === "") return { status: "empty" }
  for (const parser of parsers[locale]) {
    const [result] = parser.parse(text, now, { forwardDate: true })
    if (!result) continue
    const date = result.start.date()
    // FIXME: chrono puts a bare day at noon
    if (!result.start.isCertain("hour") && date.getHours() === 12) date.setHours(MORNING, 0, 0, 0)
    // FIXME: chrono reads a bare weekday as today until noon, even when its 9:00 has passed
    if (date <= now && result.start.isCertain("weekday") && !result.start.isCertain("day"))
      date.setDate(date.getDate() + 7)
    return { status: date.getTime() > now.getTime() ? "ok" : "past", at: date }
  }
  return { status: "unreadable" }
}
