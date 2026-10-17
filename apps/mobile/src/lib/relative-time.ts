import { copy } from "@/lib/copy"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** How long ago `iso` was: `now`, `5m`, `3h` or `2d`, then a short date such as `Oct 3`. */
export function relativeTime(iso: string, now = Date.now()) {
  const at = new Date(iso)
  const elapsed = now - at.getTime()
  if (elapsed < MINUTE) return copy("mobile_time_now")
  if (elapsed < HOUR) return copy("mobile_time_minutes", { count: String(Math.floor(elapsed / MINUTE)) })
  if (elapsed < DAY) return copy("mobile_time_hours", { count: String(Math.floor(elapsed / HOUR)) })
  if (elapsed < WEEK) return copy("mobile_time_days", { count: String(Math.floor(elapsed / DAY)) })
  const sameYear = at.getFullYear() === new Date(now).getFullYear()
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })
}
