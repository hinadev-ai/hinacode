import { Cron, DateTime, Option } from "effect"
import { isCronExpression, type RoutineSchedule } from "../../../../shared/domain.ts"
import { m } from "../../../paraglide/messages.js"

export const repeats = ["none", "hourly", "daily", "weekdays", "weekly", "custom"] as const
export type Repeat = (typeof repeats)[number]

export interface ScheduleDraft {
  readonly repeat: Repeat
  readonly hour: number
  readonly minute: number
  readonly days: ReadonlyArray<number>
  readonly cron: string
}

export const defaultScheduleDraft: ScheduleDraft = { repeat: "daily", hour: 9, minute: 0, days: [1], cron: "0 9 * * *" }

export const weekdays = [1, 2, 3, 4, 5, 6, 0] as const

export function toCron(draft: ScheduleDraft): string | null {
  const { minute, hour } = draft
  switch (draft.repeat) {
    case "none":
      return null
    case "hourly":
      return `${minute} * * * *`
    case "daily":
      return `${minute} ${hour} * * *`
    case "weekdays":
      return `${minute} ${hour} * * 1-5`
    case "weekly":
      return `${minute} ${hour} * * ${[...new Set(draft.days)].toSorted((a, b) => a - b).join(",")}`
    case "custom":
      return draft.cron.trim()
  }
}

const number = (field: string, max: number) => {
  if (!/^\d{1,2}$/.test(field)) return null
  const value = Number(field)
  return value <= max ? value : null
}

const dayList = (field: string) => {
  if (!/^[0-6](,[0-6])*$/.test(field)) return null
  const days = field.split(",").map(Number)
  const ascending = days.every((day, index) => index === 0 || day > days[index - 1]!)
  return ascending ? days : null
}

export function fromCron(cron: string | null): ScheduleDraft {
  if (cron === null) return { ...defaultScheduleDraft, repeat: "none" }
  const custom: ScheduleDraft = { ...defaultScheduleDraft, repeat: "custom", cron }
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return custom
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  const minute = number(minuteField, 59)
  if (minute === null || dayOfMonth !== "*" || month !== "*") return custom
  if (hourField === "*") return dayOfWeek === "*" ? { ...defaultScheduleDraft, repeat: "hourly", minute, cron } : custom
  const hour = number(hourField, 23)
  if (hour === null) return custom
  const timed = { ...defaultScheduleDraft, hour, minute, cron }
  if (dayOfWeek === "*") return { ...timed, repeat: "daily" }
  if (dayOfWeek === "1-5") return { ...timed, repeat: "weekdays" }
  const days = dayList(dayOfWeek)
  return days === null ? custom : { ...timed, repeat: "weekly", days }
}

export const formatClock = (hour: number, minute: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    Date.UTC(1970, 0, 1, hour, minute),
  )

const SUNDAY_1970 = 4

export const weekdayName = (day: number, locale: string, width: "short" | "long" = "short") =>
  new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(Date.UTC(1970, 0, SUNDAY_1970 + day))

export function describeCron(cron: string, locale: string): string {
  const draft = fromCron(cron)
  const time = formatClock(draft.hour, draft.minute, locale)
  switch (draft.repeat) {
    case "none":
    case "custom":
      return cron
    case "hourly":
      return m.routines_describe_hourly({ minute: String(draft.minute).padStart(2, "0") })
    case "daily":
      return m.routines_describe_daily({ time })
    case "weekdays":
      return m.routines_describe_weekdays({ time })
    case "weekly":
      return m.routines_describe_weekly({
        days: new Intl.ListFormat(locale, { style: "narrow" }).format(
          draft.days.map((day) => weekdayName(day, locale)),
        ),
        time,
      })
  }
}

export function nextRuns(schedule: RoutineSchedule, from: Date, count: number): ReadonlyArray<Date> {
  if (!isCronExpression(schedule.cron, schedule.timezone)) return []
  const cron = Cron.parseUnsafe(schedule.cron, schedule.timezone)
  const runs: Array<Date> = []
  for (const date of Cron.sequence(cron, from)) {
    runs.push(date)
    if (runs.length === count) break
  }
  return runs
}

export interface DaySlot {
  readonly key: string
  readonly weekday: number
  readonly day: number
  readonly first: Date | undefined
  readonly count: number
}

const dayKeyFormat = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })

export const RUNS_COUNTED_PER_DAY = 100

const localMidnight = (date: Date, timeZone: string) =>
  DateTime.makeZoned(date, { timeZone, adjustForTimeZone: true }).pipe(Option.map(DateTime.toEpochMillis))

export function weekAhead(schedule: RoutineSchedule, from: Date): ReadonlyArray<DaySlot> {
  const local = dayKeyFormat(schedule.timezone)
  const utc = dayKeyFormat("UTC")
  const [year, month, day] = local.format(from).split("-").map(Number) as [number, number, number]
  const dates = Array.from({ length: 7 }, (_, offset) => new Date(Date.UTC(year, month - 1, day + offset)))
  const cron = isCronExpression(schedule.cron, schedule.timezone)
    ? Cron.parseUnsafe(schedule.cron, schedule.timezone)
    : undefined
  return dates.map((date, index) => {
    const key = utc.format(date)
    const slot = { key, weekday: date.getUTCDay(), day: date.getUTCDate() }
    const start =
      index === 0 ? Option.some(from.getTime()) : Option.map(localMidnight(date, schedule.timezone), (ms) => ms - 1)
    if (cron === undefined || Option.isNone(start)) return { ...slot, first: undefined, count: 0 }
    let first: Date | undefined
    let count = 0
    for (const run of Cron.sequence(cron, new Date(start.value))) {
      if (local.format(run) !== key || count === RUNS_COUNTED_PER_DAY) break
      first ??= run
      count += 1
    }
    return { ...slot, first, count }
  })
}
