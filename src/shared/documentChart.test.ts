import { CHART_GUIDE } from "@hinacode/artifacts"
import { expect, test } from "vitest"
import { parseChart } from "./documentChart.ts"

const guideExample = /```chart\n([\s\S]*?)\n```/.exec(CHART_GUIDE)?.[1] ?? ""

test("draws the example the agent learns from", () => {
  const parsed = parseChart(guideExample)

  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  expect(parsed.chart.spec.type).toBe("bar")
  expect(parsed.chart.labels).toEqual(["Chat", "Drama", "Replay"])
  expect(parsed.chart.points).toContainEqual({ x: "10-17", series: "Chat", value: 54800 })
  expect(parsed.chart.peak).toEqual({ x: "10-17", total: 63900 })
})

test("treats a missing or empty value as zero and keeps the rows' order", () => {
  const parsed = parseChart(
    JSON.stringify({
      type: "line",
      x: "week",
      series: [{ key: "open" }],
      rows: [{ week: "W2", open: 3 }, { week: "W1" }, { week: "W3", open: null }],
    }),
  )

  expect(parsed.ok && parsed.chart.points).toEqual([
    { x: "W2", series: "open", value: 3 },
    { x: "W1", series: "open", value: 0 },
    { x: "W3", series: "open", value: 0 },
  ])
})

test("names the problem when the agent's chart cannot be drawn", () => {
  expect(parseChart("{ not json")).toMatchObject({ ok: false })
  expect(parseChart(JSON.stringify({ type: "pie", x: "day", series: [{ key: "a" }], rows: [] }))).toMatchObject({
    ok: false,
    message: expect.stringContaining("type"),
  })
  expect(
    parseChart(
      JSON.stringify({ type: "bar", x: "day", series: [{ key: "chat" }], rows: [{ day: "1", chat: "many" }] }),
    ),
  ).toEqual({ ok: false, message: 'Row 1 has "chat": "many", which is not a number.' })
})
