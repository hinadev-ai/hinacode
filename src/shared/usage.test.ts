import { describe, expect, it } from "vitest"
import { periodStart, summarizeUsage, type UsageRow, wholePercents } from "./usage.ts"

const row = (overrides: Partial<UsageRow>): UsageRow => ({
  threadId: "t1",
  projectId: "p1",
  projectName: "secret-repo",
  provider: "claude",
  model: "claude-opus-5-5",
  turns: 1,
  tokens: 100,
  ...overrides,
})

const NOW = Date.parse("2026-11-13T12:00:00.000Z")

describe("periodStart", () => {
  it("starts 7 and 30 days back, and all time has no start", () => {
    expect(periodStart("7d", NOW)).toBe("2026-11-06T12:00:00.000Z")
    expect(periodStart("30d", NOW)).toBe("2026-10-14T12:00:00.000Z")
    expect(periodStart("all", NOW)).toBeNull()
  })
})

describe("wholePercents", () => {
  it("rounds shares so they add up to 100", () => {
    expect(wholePercents([1, 1, 1])).toStrictEqual([34, 33, 33])
    expect(wholePercents([2, 1])).toStrictEqual([67, 33])
  })

  it("gives nothing a share when there is no usage", () => {
    expect(wholePercents([0, 0])).toStrictEqual([0, 0])
  })
})

describe("summarizeUsage", () => {
  const rows = [
    row({ threadId: "t1", provider: "claude", model: "claude-opus-5-5", turns: 6, tokens: 600 }),
    row({ threadId: "t2", provider: "claude", model: "claude-sonnet-5-5", turns: 2, tokens: 200 }),
    row({
      threadId: "t3",
      provider: "codex",
      model: "gpt-6.1-sol",
      turns: 3,
      tokens: 900,
      projectId: "p2",
      projectName: "client-x",
    }),
    row({ threadId: "t1", provider: "magpie", model: null, turns: 1, tokens: 0 }),
  ]

  it("ranks providers by turns with whole percent shares", () => {
    const summary = summarizeUsage(rows)

    expect(
      summary.providers.map(({ provider, turns, percent, threads }) => ({ provider, turns, percent, threads })),
    ).toStrictEqual([
      { provider: "claude", turns: 8, percent: 67, threads: 2 },
      { provider: "codex", turns: 3, percent: 25, threads: 1 },
      { provider: "magpie", turns: 1, percent: 8, threads: 1 },
    ])
  })

  it("counts a thread once even when two agents worked in it", () => {
    expect(summarizeUsage(rows)).toMatchObject({ threads: 3, turns: 12, tokens: 1700 })
  })

  it("lists each provider's top models and leaves out turns with no known model", () => {
    const [claude, , magpie] = summarizeUsage(rows, { modelsPerProvider: 1 }).providers

    expect(claude?.models).toStrictEqual([{ model: "claude-opus-5-5", turns: 6 }])
    expect(magpie?.models).toStrictEqual([])
  })

  it("shows project names unless asked to mask them", () => {
    expect(summarizeUsage(rows).projects).toStrictEqual([
      { name: "secret-repo", percent: 75 },
      { name: "client-x", percent: 25 },
    ])
  })

  it("replaces every project name with its rank when masked", () => {
    const summary = summarizeUsage(rows, { maskProject: (rank) => `Project ${rank}` })

    expect(summary.projects).toStrictEqual([
      { name: "Project 1", percent: 75 },
      { name: "Project 2", percent: 25 },
    ])
    expect(JSON.stringify(summary)).not.toMatch(/secret-repo|client-x/)
  })

  it("summarizes an empty period as zeros", () => {
    expect(summarizeUsage([])).toStrictEqual({ threads: 0, turns: 0, tokens: 0, providers: [], projects: [] })
  })
})
