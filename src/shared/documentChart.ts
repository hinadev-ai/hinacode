import { Result, Schema } from "effect"

const Cell = Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))

export const ChartSpec = Schema.Struct({
  type: Schema.Literals(["bar", "line"]),
  title: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.String),
  x: Schema.String,
  series: Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.optionalKey(Schema.String) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(6),
  ),
  unit: Schema.optionalKey(
    Schema.Struct({ prefix: Schema.optionalKey(Schema.String), suffix: Schema.optionalKey(Schema.String) }),
  ),
  rows: Schema.Array(Schema.Record(Schema.String, Cell)).check(Schema.isMaxLength(500)),
})
export type ChartSpec = typeof ChartSpec.Type

export type ChartPoint = { readonly x: string; readonly series: string; readonly value: number }

export type Chart = {
  readonly spec: ChartSpec
  readonly labels: ReadonlyArray<string>
  readonly points: ReadonlyArray<ChartPoint>
  readonly peak: { readonly x: string; readonly total: number } | null
}

export type ParsedChart =
  | { readonly ok: true; readonly chart: Chart }
  | { readonly ok: false; readonly message: string }

const decodeSpec = Schema.decodeUnknownResult(Schema.fromJsonString(ChartSpec))

const valueOf = (cell: typeof Cell.Type | undefined) => (cell === undefined || cell === null ? 0 : cell)

export const parseChart = (source: string): ParsedChart => {
  const decoded = decodeSpec(source)
  if (Result.isFailure(decoded)) return { ok: false, message: decoded.failure.message }
  const spec = decoded.success
  const labels = spec.series.map((series) => series.label ?? series.key)
  const points: Array<ChartPoint> = []
  const totals = new Map<string, number>()
  for (const [index, row] of spec.rows.entries()) {
    const x = String(row[spec.x] ?? "")
    for (const [seriesIndex, series] of spec.series.entries()) {
      const value = valueOf(row[series.key])
      if (typeof value !== "number" || !Number.isFinite(value))
        return {
          ok: false,
          message: `Row ${index + 1} has "${series.key}": ${JSON.stringify(value)}, which is not a number.`,
        }
      points.push({ x, series: labels[seriesIndex] ?? series.key, value })
      totals.set(x, (totals.get(x) ?? 0) + value)
    }
  }
  const heights =
    spec.type === "bar"
      ? Array.from(totals, ([x, total]) => ({ x, total }))
      : points.map(({ x, value }) => ({ x, total: value }))
  const peak = heights.reduce<Chart["peak"]>(
    (highest, candidate) => (highest === null || candidate.total > highest.total ? candidate : highest),
    null,
  )
  return { ok: true, chart: { spec, labels, points, peak } }
}

export const formatChartValue = (
  spec: ChartSpec,
  value: number,
  locale: string,
  notation: "standard" | "compact" = "standard",
) => {
  const digits = notation === "compact" ? 1 : 2
  const number = new Intl.NumberFormat(locale, { notation, maximumFractionDigits: digits }).format(value)
  return `${spec.unit?.prefix ?? ""}${number}${spec.unit?.suffix ?? ""}`
}
