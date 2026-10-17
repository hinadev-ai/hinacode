import { copy } from "@/lib/copy"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const units = [
  { key: "mobile_time_minutes", size: MINUTE, below: HOUR },
  { key: "mobile_time_hours", size: HOUR, below: DAY },
  { key: "mobile_time_days", size: DAY, below: 7 * DAY },
  { key: "mobile_time_weeks", size: 7 * DAY, below: 30 * DAY },
  { key: "mobile_time_months", size: 30 * DAY, below: 365 * DAY },
  { key: "mobile_time_years", size: 365 * DAY, below: Infinity },
] as const

/** How long ago `iso` was in the largest whole unit, like the desktop sidebar: `now`, `5m ago`, `3h ago`, `2w ago`. */
export function relativeTime(iso: string, now = Date.now()) {
  const elapsed = now - Date.parse(iso)
  // Anything under a minute, including a time slightly in the future from clock skew, is now.
  if (!(elapsed >= MINUTE)) return copy("mobile_time_now")
  const { key, size } = units.find(({ below }) => elapsed < below) ?? units[units.length - 1]
  return copy(key, { count: String(Math.floor(elapsed / size)) })
}
