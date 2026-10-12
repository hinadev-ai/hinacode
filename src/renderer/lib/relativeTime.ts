const second = 1000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour

const units: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; size: number; below: number }> = [
  { unit: "minute", size: minute, below: hour },
  { unit: "hour", size: hour, below: day },
  { unit: "day", size: day, below: 7 * day },
  { unit: "week", size: 7 * day, below: 30 * day },
  { unit: "month", size: 30 * day, below: 365 * day },
  { unit: "year", size: 365 * day, below: Infinity },
]

/** How long ago `iso` was, in the largest whole unit: "now", "5m ago", "3h ago", "2w ago". */
export function formatRelativeTime(iso: string, now: number, locale: string): string {
  const elapsed = now - Date.parse(iso)
  // Anything under a minute, including a timestamp slightly in the future from clock skew, is "now".
  if (elapsed < minute) {
    return new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: "auto" }).format(0, "second")
  }
  const { unit, size } = units.find(({ below }) => elapsed < below)!
  const format = new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: "always" })
  return format.format(-Math.floor(elapsed / size), unit)
}
