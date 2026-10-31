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

const formats = new Map<string, Intl.RelativeTimeFormat>()

function formatFor(locale: string, numeric: "auto" | "always") {
  const key = `${locale} ${numeric}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric })
    formats.set(key, format)
  }
  return format
}

export function formatRelativeTime(iso: string, now: number, locale: string): string {
  const elapsed = now - Date.parse(iso)
  if (elapsed < minute) {
    return formatFor(locale, "auto").format(0, "second")
  }
  const { unit, size } = units.find(({ below }) => elapsed < below)!
  return formatFor(locale, "always").format(-Math.floor(elapsed / size), unit)
}
