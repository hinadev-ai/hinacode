import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { useShallow } from "zustand/react/shallow"
import type { ContextBreakdown, ContextWindow, ProviderId } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { contextBreakdownAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useMessages } from "../stores/messages.ts"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./ui/popover.tsx"
import { Skeleton } from "./ui/skeleton.tsx"

const RADIUS = 6.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const WARNING_FRACTION = 0.8
/** Swatches for the `used` categories, in the order the agent lists them. */
const USED_SWATCHES = [
  "bg-blue-500",
  "bg-orange-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-pink-500",
  "bg-cyan-500",
]

type Category = ContextBreakdown["categories"][number]
type Segment = { readonly key: string; readonly tokens: number; readonly className: string | undefined }

const formatTokens = (tokens: number) =>
  new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(tokens)

const formatShare = (fraction: number) =>
  new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 1 }).format(fraction)

/**
 * The context window as of the thread's latest completed turn that reported one. A `/compact` turn makes
 * no model request, so a compaction after that turn sets what is used instead.
 */
const latestContext =
  (threadId: string) =>
  (state: ReturnType<typeof useMessages.getState>): ContextWindow | null => {
    const history = state.byThread[threadId]
    if (history?.status !== "ready") return null
    let compactedTo: number | null = null
    for (let index = history.messages.length - 1; index >= 0; index--) {
      const message = history.messages[index]
      if (message?.role !== "assistant") continue
      const context = message.usage?.context
      if (context !== undefined) return compactedTo === null ? context : { ...context, usedTokens: compactedTo }
      compactedTo ??= compactedTokens(message.parts)
    }
    return null
  }

const compactedTokens = (parts: ReadonlyArray<MessagePart>) => {
  const compaction = parts.findLast((part) => part.type === "compaction")?.compaction
  return compaction?.status === "done" ? compaction.postTokens : null
}

const fractionOf = ({ usedTokens, maxTokens }: ContextWindow) =>
  maxTokens > 0 ? Math.min(usedTokens / maxTokens, 1) : 0

/** How full the agent's context window is, so the developer knows when to start a fresh thread. */
export function ContextRing({ threadId, provider }: { threadId: string; provider: ProviderId }) {
  const context = useMessages(useShallow(latestContext(threadId)))
  if (context === null) return null
  const fraction = fractionOf(context)
  const percent = Math.round(fraction * 100)
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={300}
        aria-label={m.thread_context_value({
          percent,
          used: formatTokens(context.usedTokens),
          max: formatTokens(context.maxTokens),
        })}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
          fraction >= WARNING_FRACTION ? "text-attention" : "text-muted-foreground",
        )}
      >
        <Ring fraction={fraction} />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="max-h-(--available-height) w-80 gap-3 overflow-y-auto tabular-nums *:shrink-0"
      >
        <PopoverTitle>{m.thread_context_window()}</PopoverTitle>
        {/* Codex and Muse report only how many tokens are used, not what they hold. */}
        {provider === "claude" ? <Breakdown threadId={threadId} context={context} /> : <Totals context={context} />}
      </PopoverContent>
    </Popover>
  )
}

function Ring({ fraction }: { fraction: number }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
      {fraction > 0 && (
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          className="stroke-current transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none"
        />
      )}
    </svg>
  )
}

/** Only mounts while the popover is open, so the agent counts its context only when someone looks. */
function Breakdown({ threadId, context }: { threadId: string; context: ContextWindow }) {
  const result = useAtomValue(contextBreakdownAtom(threadId))
  return AsyncResult.builder(result)
    .onSuccess((breakdown) =>
      breakdown === null ? (
        <>
          <Totals context={context} />
          <Note>{m.thread_context_breakdown_unavailable()}</Note>
        </>
      ) : (
        <Categories breakdown={breakdown} />
      ),
    )
    .onError((error) => (
      <>
        <Totals context={context} />
        <Note attention>{m.thread_context_breakdown_failed({ error: errorMessage(error) })}</Note>
      </>
    ))
    .orElse(() => (
      <>
        <Totals context={context} />
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-4" />
          ))}
        </div>
      </>
    ))
}

function Totals({ context }: { context: ContextWindow }) {
  return (
    <>
      <Summary context={context} />
      <Bar
        maxTokens={context.maxTokens}
        segments={[{ key: "used", tokens: context.usedTokens, className: USED_SWATCHES[0] }]}
      />
    </>
  )
}

function Summary({ context }: { context: ContextWindow }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-medium">{m.thread_context_used({ percent: Math.round(fractionOf(context) * 100) })}</span>
      <span className="text-muted-foreground">
        {m.thread_context_tokens({ used: formatTokens(context.usedTokens), max: formatTokens(context.maxTokens) })}
      </span>
    </div>
  )
}

function Bar({ maxTokens, segments }: { maxTokens: number; segments: ReadonlyArray<Segment> }) {
  return (
    <div className="-mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
      {segments.map((segment) => (
        <div
          key={segment.key}
          className={segment.className}
          style={{ width: `${maxTokens > 0 ? (segment.tokens / maxTokens) * 100 : 0}%` }}
        />
      ))}
    </div>
  )
}

function Note({ attention = false, children }: { attention?: boolean; children: string }) {
  return <p className={cn("text-xs text-muted-foreground", attention && "text-attention")}>{children}</p>
}

function Categories({ breakdown }: { breakdown: ContextBreakdown }) {
  const { maxTokens, categories } = breakdown
  const swatches = swatchesFor(categories)
  const share = (tokens: number) => formatShare(maxTokens > 0 ? tokens / maxTokens : 0)
  return (
    <>
      <Summary context={breakdown} />
      <Bar
        maxTokens={maxTokens}
        segments={categories
          .filter((category) => category.kind !== "free")
          .map((category) => ({ key: category.name, tokens: category.tokens, className: swatches.get(category) }))}
      />
      <ul className="flex flex-col gap-1.5 text-xs">
        {categories.map((category) => (
          <li key={category.name} className="grid grid-cols-[auto_1fr_auto_3.5rem] items-center gap-2">
            <span className={cn("size-2.5 rounded-[3px]", swatches.get(category))} aria-hidden />
            <span className="truncate" title={category.name}>
              {category.name}
            </span>
            <span className="text-muted-foreground">{formatTokens(category.tokens)}</span>
            <span className="text-end font-medium">{share(category.tokens)}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

const swatchesFor = (categories: ReadonlyArray<Category>) => {
  let used = 0
  return new Map(
    categories.map((category) => {
      switch (category.kind) {
        case "used":
          return [category, USED_SWATCHES[used++ % USED_SWATCHES.length]]
        case "buffer":
          return [category, "bg-muted-foreground/40"]
        case "free":
          return [category, "bg-muted"]
      }
    }),
  )
}
