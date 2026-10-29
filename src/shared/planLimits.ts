import type { AccountLimits, AgentProfile, ProviderId } from "./agent.ts"
import type { LimitWindow } from "./limits.ts"

const minuteMs = 60_000
const hourMinutes = 60
const dayMinutes = 24 * hourMinutes

const unit = (locale: string, value: number, name: "day" | "hour" | "minute") =>
  new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value)

export function formatMinutes(total: number, locale: string): string {
  const days = Math.floor(total / dayMinutes)
  const hours = Math.floor((total % dayMinutes) / hourMinutes)
  const minutes = total % hourMinutes
  if (days > 0) return `${unit(locale, days, "day")} ${unit(locale, hours, "hour")}`
  if (hours > 0) return `${unit(locale, hours, "hour")} ${unit(locale, minutes, "minute")}`
  return unit(locale, minutes, "minute")
}

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

const resetsLater = (a: LimitWindow, b: LimitWindow) =>
  a.resetsAt === null || (b.resetsAt !== null && a.resetsAt > b.resetsAt)

export const spentWindow = (windows: ReadonlyArray<LimitWindow>, model: string) =>
  windows
    .filter((window) => blocks(window, model))
    .reduce<LimitWindow | undefined>(
      (last, window) => (last === undefined || resetsLater(window, last) ? window : last),
      undefined,
    )

export interface AccountOption {
  readonly id: string | null
  readonly name: string
  readonly mostUsed: LimitWindow | undefined
  readonly spent: LimitWindow | undefined
}

export const accountOptions = (
  thread: { readonly provider: ProviderId; readonly model: string },
  defaultName: string,
  profiles: ReadonlyArray<AgentProfile>,
  limits: ReadonlyArray<AccountLimits>,
): ReadonlyArray<AccountOption> =>
  [{ id: null, name: defaultName }, ...profiles.filter((profile) => profile.provider === thread.provider)].map(
    ({ id, name }) => {
      const windows =
        limits.find((entry) => entry.provider === thread.provider && entry.accountId === id)?.limits?.windows ?? []
      return { id, name, mostUsed: mostUsed(windows), spent: spentWindow(windows, thread.model) }
    },
  )
