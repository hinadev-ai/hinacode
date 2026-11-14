import { cn } from "cn"
import type { Ref } from "react"
import type { UsagePeriod, UsageSummary } from "../../shared/usage.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { HinaCodeMark } from "./icons/HinaCodeMark.tsx"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"

const periodLabel = {
  "7d": m.usage_card_period_7d,
  "30d": m.usage_card_period_30d,
  all: m.usage_card_period_all,
} satisfies Record<UsagePeriod, () => string>

const formatCount = (value: number) => new Intl.NumberFormat(getLocale()).format(value)

const formatCompact = (value: number) =>
  new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(value)

const formatPercent = (percent: number) =>
  new Intl.NumberFormat(getLocale(), { style: "percent" }).format(percent / 100)

const shortModel = (model: string) => model.split("/").at(-1) ?? model

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-5xl font-semibold tracking-tight tabular-nums">{value}</span>
      <span className="text-base text-share-muted">{label}</span>
    </div>
  )
}

interface UsageCardProps {
  readonly summary: UsageSummary
  readonly period: UsagePeriod
  readonly ref?: Ref<HTMLElement>
}

export function UsageCard({ summary, period, ref }: UsageCardProps) {
  return (
    <section
      ref={ref}
      aria-label={m.usage_card_label()}
      className="share-card aspect-video w-full overflow-hidden bg-share-ink text-share-paper"
    >
      <div className="flex size-full flex-col px-14 pt-12 pb-10">
        <header className="flex items-center gap-3">
          <HinaCodeMark className="size-9" />
          <span className="text-2xl font-semibold tracking-tight">HinaCode</span>
          <span className="ms-auto text-lg text-share-muted">{periodLabel[period]()}</span>
        </header>

        <div className="mt-10 flex gap-20">
          <Stat label={m.usage_turns()} value={formatCount(summary.turns)} />
          <Stat label={m.usage_threads()} value={formatCount(summary.threads)} />
          <Stat label={m.usage_tokens()} value={formatCompact(summary.tokens)} />
        </div>

        {summary.turns === 0 ? (
          <p className="flex flex-1 items-center text-xl text-share-muted">{m.usage_empty()}</p>
        ) : (
          <div className="mt-10 flex min-h-0 flex-1 gap-16">
            <section className="flex min-w-0 flex-2 flex-col gap-4">
              <h2 className="text-sm text-share-muted">{m.usage_agents()}</h2>
              <ol className="flex flex-col gap-4">
                {summary.providers.map((usage, index) => (
                  <li key={usage.provider} className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <span className="w-5 text-lg text-share-muted tabular-nums">{index + 1}</span>
                      <ProviderIcon provider={usage.provider} className="size-6 text-share-paper" />
                      <span className="text-xl font-medium">{providerLabel[usage.provider]()}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-share-muted">
                        {usage.models.map((model) => shortModel(model.model)).join(", ")}
                      </span>
                      <span className="text-sm text-share-muted tabular-nums">
                        {m.usage_provider_turns({ count: usage.turns, turns: formatCount(usage.turns) })}
                      </span>
                      <span className="w-16 text-end text-xl font-semibold tabular-nums">
                        {formatPercent(usage.percent)}
                      </span>
                    </div>
                    <div className="ms-8 h-1.5 rounded-full bg-share-line">
                      <div
                        className={cn("h-full rounded-full", index === 0 ? "bg-share-coral" : "bg-share-paper")}
                        style={{ width: `${usage.percent}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section className="flex min-w-0 flex-1 flex-col gap-4">
              <h2 className="text-sm text-share-muted">{m.usage_projects()}</h2>
              <ol className="flex flex-col gap-3">
                {summary.projects.map((project) => (
                  <li key={project.name} className="flex items-baseline gap-3 text-lg">
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <span className="text-share-muted tabular-nums">{formatPercent(project.percent)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}

        <footer className="mt-auto flex justify-end pt-6 text-base text-share-muted">hinacode.app</footer>
      </div>
    </section>
  )
}
