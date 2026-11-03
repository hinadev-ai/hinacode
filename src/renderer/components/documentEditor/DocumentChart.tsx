import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { lazy, Suspense, useDeferredValue, useState } from "react"
import { type Chart, formatChartValue, parseChart } from "../../../shared/documentChart.ts"
import { useDebouncedValue } from "../../lib/useDebouncedValue.ts"
import { m } from "../../paraglide/messages.js"
import { getLocale } from "../../paraglide/runtime.js"
import { Button } from "../ui/button.tsx"
import { chartLane } from "./chartLanes.ts"
import { CHART_LANGUAGE, CodeLanguagePicker } from "./CodeLanguagePicker.tsx"

const ChartPlot = lazy(() => import("./ChartPlot.tsx"))

const REDRAW_DELAY_MS = 200

type Panel = "none" | "data" | "source"

export function ChartBlock({ node, updateAttributes }: ReactNodeViewProps) {
  const [panel, setPanel] = useState<Panel>("none")
  const source = useDeferredValue(useDebouncedValue(node.textContent, REDRAW_DELAY_MS))
  const parsed = parseChart(source)
  const toggle = (next: Panel) => setPanel((current) => (current === next ? "none" : next))
  return (
    <NodeViewWrapper data-chart className="not-prose my-5 overflow-hidden rounded-xl border border-border">
      <div contentEditable={false} data-node-control className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {parsed.ok && parsed.chart.spec.title !== undefined && (
              <p data-chart-title className="text-sm font-semibold text-pretty text-foreground">
                {parsed.chart.spec.title}
              </p>
            )}
            {parsed.ok && parsed.chart.spec.notes !== undefined && (
              <p data-chart-notes className="mt-1 text-xs whitespace-pre-line text-muted-foreground">
                {parsed.chart.spec.notes}
              </p>
            )}
            {!parsed.ok && (
              <p role="alert" className="text-xs wrap-anywhere text-destructive">
                {m.documents_chart_invalid({ message: parsed.message })}
              </p>
            )}
          </div>
          <div data-print-hidden className="flex shrink-0 items-center gap-0.5">
            {parsed.ok && (
              <Button
                variant="ghost"
                size="xs"
                className="aria-pressed:bg-muted aria-pressed:text-foreground"
                aria-pressed={panel === "data"}
                action={() => toggle("data")}
              >
                {m.documents_chart_data()}
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              className="aria-pressed:bg-muted aria-pressed:text-foreground"
              aria-pressed={panel === "source"}
              action={() => toggle("source")}
            >
              {m.documents_chart_source()}
            </Button>
          </div>
        </div>
        {parsed.ok && <ChartBody chart={parsed.chart} />}
      </div>
      {parsed.ok && panel === "data" && <ChartData chart={parsed.chart} />}
      <div hidden={parsed.ok && panel !== "source"} className="relative">
        <pre
          spellCheck={false}
          className="m-0 border-t border-border bg-muted px-4 py-3 font-mono text-xs whitespace-pre-wrap"
        >
          <NodeViewContent<"code"> as="code" />
        </pre>
        <div contentEditable={false} data-node-control data-print-hidden className="absolute top-1.5 right-1.5">
          <CodeLanguagePicker language={CHART_LANGUAGE} onChange={(next) => updateAttributes({ language: next })} />
        </div>
      </div>
    </NodeViewWrapper>
  )
}

function ChartBody({ chart }: { chart: Chart }) {
  return (
    <>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {chart.labels.map((label, index) => (
          <li key={label} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-xs" style={{ background: `var(${chartLane(index)})` }} />
            {label}
          </li>
        ))}
      </ul>
      <Suspense
        fallback={
          <output
            aria-label={m.documents_chart_loading()}
            className="block h-60 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
          />
        }
      >
        <ChartPlot chart={chart} />
      </Suspense>
    </>
  )
}

function ChartData({ chart }: { chart: Chart }) {
  const { spec } = chart
  return (
    <div
      contentEditable={false}
      data-node-control
      className="border-t border-border transition-opacity duration-150 ease-out starting:opacity-0"
    >
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-start font-medium">{spec.x}</th>
              {spec.series.map((series) => (
                <th key={series.key} className="px-4 py-2 text-end font-medium">
                  {series.label ?? series.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, index) => (
              <tr key={`${index}:${String(row[spec.x])}`} className="border-t border-border">
                <td className="px-4 py-1.5">{String(row[spec.x] ?? "")}</td>
                {spec.series.map((series) => {
                  const value = row[series.key]
                  return (
                    <td key={series.key} className="px-4 py-1.5 text-end">
                      {typeof value === "number" ? formatChartValue(spec, value, getLocale()) : "–"}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {m.documents_chart_rows({ count: spec.rows.length })}
      </p>
    </div>
  )
}
