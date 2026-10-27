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

export const mostUsed = (windows: ReadonlyArray<LimitWindow>) =>
  windows.reduce<LimitWindow | undefined>(
    (top, window) => (top === undefined || window.usedPercent > top.usedPercent ? window : top),
    undefined,
  )

const blocks = (window: LimitWindow, model: string) =>
  window.usedPercent >= 100 &&
  (window.window.kind !== "model" || model.toLowerCase().includes(window.window.name.toLowerCase()))

/** An unknown reset sorts last, since nothing says the account recovers sooner. */
const resetsLater = (a: LimitWindow, b: LimitWindow) =>
  a.resetsAt === null || (b.resetsAt !== null && a.resetsAt > b.resetsAt)

/**
 * The spent window that keeps an account from running `model`, the one that resets last. A per-model window
 * counts only for models whose id contains its name, such as "Fable" for `claude-fable-5-1`.
 */
export const spentWindow = (windows: ReadonlyArray<LimitWindow>, model: string) =>
  windows
    .filter((window) => blocks(window, model))
    .reduce<LimitWindow | undefined>(
      (last, window) => (last === undefined || resetsLater(window, last) ? window : last),
      undefined,
    )
