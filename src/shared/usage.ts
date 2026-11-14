import { Schema } from "effect"
import { ProviderId } from "./agent.ts"

export const UsagePeriod = Schema.Literals(["7d", "30d", "all"])
export type UsagePeriod = typeof UsagePeriod.Type

export const USAGE_PERIODS: ReadonlyArray<UsagePeriod> = ["7d", "30d", "all"]

const DAY_MS = 86_400_000
const periodDays = { "7d": 7, "30d": 30, all: null } satisfies Record<UsagePeriod, number | null>

export const periodStart = (period: UsagePeriod, nowMs: number): string | null => {
  const days = periodDays[period]
  return days === null ? null : new Date(nowMs - days * DAY_MS).toISOString()
}

export const UsageRow = Schema.Struct({
  threadId: Schema.String,
  projectId: Schema.String,
  projectName: Schema.String,
  provider: ProviderId,
  model: Schema.NullOr(Schema.String),
  turns: Schema.Number,
  tokens: Schema.Number,
})
export type UsageRow = typeof UsageRow.Type

export interface ModelUsage {
  readonly model: string
  readonly turns: number
}

export interface ProviderUsage {
  readonly provider: ProviderId
  readonly threads: number
  readonly turns: number
  readonly tokens: number
  readonly percent: number
  readonly models: ReadonlyArray<ModelUsage>
}

export interface ProjectUsage {
  readonly name: string
  readonly percent: number
}

export interface UsageSummary {
  readonly threads: number
  readonly turns: number
  readonly tokens: number
  readonly providers: ReadonlyArray<ProviderUsage>
  readonly projects: ReadonlyArray<ProjectUsage>
}

export interface SummarizeOptions {
  readonly maskProject?: (rank: number) => string
  readonly modelsPerProvider?: number
  readonly projectLimit?: number
}

export const wholePercents = (values: ReadonlyArray<number>): ReadonlyArray<number> => {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total === 0) return values.map(() => 0)
  const exact = values.map((value) => (value / total) * 100)
  const floors = exact.map(Math.floor)
  const missing = 100 - floors.reduce((sum, value) => sum + value, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - floors[index]! }))
    .toSorted((a, b) => b.remainder - a.remainder)
  const bumped = new Set(byRemainder.slice(0, missing).map(({ index }) => index))
  return floors.map((value, index) => (bumped.has(index) ? value + 1 : value))
}

const sumBy = <K>(rows: ReadonlyArray<UsageRow>, key: (row: UsageRow) => K) => {
  const totals = new Map<K, { turns: number; tokens: number; threads: Set<string> }>()
  for (const row of rows) {
    const total = totals.get(key(row)) ?? { turns: 0, tokens: 0, threads: new Set<string>() }
    total.turns += row.turns
    total.tokens += row.tokens
    total.threads.add(row.threadId)
    totals.set(key(row), total)
  }
  return [...totals]
    .map(([id, total]) => ({ id, turns: total.turns, tokens: total.tokens, threads: total.threads.size }))
    .toSorted((a, b) => b.turns - a.turns || b.tokens - a.tokens)
}

export const summarizeUsage = (rows: ReadonlyArray<UsageRow>, options: SummarizeOptions = {}): UsageSummary => {
  const { maskProject, modelsPerProvider = 3, projectLimit = 3 } = options
  const providers = sumBy(rows, (row) => row.provider)
  const providerPercents = wholePercents(providers.map((provider) => provider.turns))
  const projects = sumBy(rows, (row) => row.projectId)
  const projectPercents = wholePercents(projects.map((project) => project.turns))
  const projectNames = new Map(rows.map((row) => [row.projectId, row.projectName]))

  return {
    threads: new Set(rows.map((row) => row.threadId)).size,
    turns: rows.reduce((sum, row) => sum + row.turns, 0),
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    providers: providers.map((provider, index) => ({
      provider: provider.id,
      threads: provider.threads,
      turns: provider.turns,
      tokens: provider.tokens,
      percent: providerPercents[index]!,
      models: sumBy(
        rows.filter((row) => row.provider === provider.id && row.model !== null),
        (row) => row.model!,
      )
        .slice(0, modelsPerProvider)
        .map((model) => ({ model: model.id, turns: model.turns })),
    })),
    projects: projects.slice(0, projectLimit).map((project, index) => ({
      name: maskProject ? maskProject(index + 1) : projectNames.get(project.id)!,
      percent: projectPercents[index]!,
    })),
  }
}
