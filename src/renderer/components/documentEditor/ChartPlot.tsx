import * as Plot from "@observablehq/plot"
import { useEffect, useRef } from "react"
import type { ArtifactTheme } from "../../../shared/artifactTheme.ts"
import { type Chart, formatChartValue } from "../../../shared/documentChart.ts"
import { useArtifactTheme } from "../../lib/artifactTheme.ts"
import { getLocale } from "../../paraglide/runtime.js"
import { chartLane } from "./chartLanes.ts"

const HEIGHT = 240

const draw = (chart: Chart, tokens: ArtifactTheme["tokens"], width: number, locale: string) => {
  const { spec, labels, points, peak } = chart
  const bar = spec.type === "bar"
  const xs = Array.from(new Set(points.map((point) => point.x)))
  const compact = (value: number) => formatChartValue(spec, value, locale, "compact")
  return Plot.plot({
    width,
    height: HEIGHT,
    ariaLabel: spec.title ?? labels.join(", "),
    marginTop: 24,
    marginLeft: 52,
    marginBottom: 28,
    style: { background: "transparent", color: tokens["--muted-foreground"], fontFamily: "inherit", fontSize: "11px" },
    x: { type: bar ? "band" : "point", domain: xs, label: null, tickSize: 0, padding: bar ? 0.35 : 0.5 },
    y: { grid: true, nice: true, ticks: 4, label: null, tickSize: 0, tickFormat: compact },
    color: { domain: labels, range: labels.map((_label, index) => tokens[chartLane(index)]) },
    marks: [
      Plot.ruleY([0], { stroke: tokens["--border"] }),
      bar
        ? Plot.barY(points, { x: "x", y: "value", fill: "series", tip: { format: { y: compact } } })
        : [
            Plot.lineY(points, { x: "x", y: "value", stroke: "series", strokeWidth: 2, curve: "monotone-x" }),
            Plot.dot(points, { x: "x", y: "value", fill: "series", r: 2.5, tip: { format: { y: compact } } }),
          ],
      peak === null
        ? null
        : Plot.text([peak], {
            x: "x",
            y: "total",
            text: (point: NonNullable<Chart["peak"]>) => formatChartValue(spec, point.total, locale),
            dy: -9,
            fill: tokens["--foreground"],
            fontWeight: 600,
          }),
    ],
  })
}

export default function ChartPlot({ chart }: { chart: Chart }) {
  const container = useRef<HTMLDivElement>(null)
  const theme = useArtifactTheme()

  useEffect(() => {
    const element = container.current
    if (element === null) return
    const { tokens } = JSON.parse(theme) as ArtifactTheme
    let width = 0
    const render = () => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      element.replaceChildren(draw(chart, tokens, width, getLocale()))
    }
    render()
    const observer = new ResizeObserver(render)
    observer.observe(element)
    return () => observer.disconnect()
  }, [chart, theme])

  return <div ref={container} className="h-60 transition-opacity duration-200 ease-out starting:opacity-0" />
}
