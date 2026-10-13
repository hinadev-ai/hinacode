import type { LimitWindow } from "../../shared/limits.ts"

const minuteMs = 60_000
const hourMinutes = 60
const dayMinutes = 24 * hourMinutes

const unit = (locale: string, value: number, name: "day" | "hour" | "minute") =>
  new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value)

/** A length in minutes in its two largest units: "0m", "45m", "3h 12m", "2d 6h". */
export function formatMinutes(total: number, locale: string): string {
  const days = Math.floor(total / dayMinutes)
  const hours = Math.floor((total % dayMinutes) / hourMinutes)
  const minutes = total % hourMinutes
  if (days > 0) return `${unit(locale, days, "day")} ${unit(locale, hours, "hour")}`
  if (hours > 0) return `${unit(locale, hours, "hour")} ${unit(locale, minutes, "minute")}`
  return unit(locale, minutes, "minute")
}

/** Time left until `resetsAt`, rounded down to the minute. A reset already past reads as "0m". */
export const formatResetIn = (resetsAt: string, now: number, locale: string) =>
  formatMinutes(Math.max(0, Math.floor((Date.parse(resetsAt) - now) / minuteMs)), locale)

/** A window is amber from 80% used and red once it is spent. */
export const limitLevel = (usedPercent: number) =>
  usedPercent >= 100 ? "exhausted" : usedPercent >= 80 ? "warning" : "normal"

export const mostUsed = (windows: ReadonlyArray<LimitWindow>) =>
  windows.reduce<LimitWindow | undefined>(
    (top, window) => (top === undefined || window.usedPercent > top.usedPercent ? window : top),
    undefined,
  )
