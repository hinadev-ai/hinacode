// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-tabindex -- a native <meter> cannot draw a ring, and the meter takes focus so keyboard users can open its tooltip.
import { cn } from "cn"
import { useShallow } from "zustand/react/shallow"
import type { ContextWindow } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useMessages } from "../stores/messages.ts"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const RADIUS = 6.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const WARNING_FRACTION = 0.8

const formatTokens = (tokens: number) => new Intl.NumberFormat(getLocale(), { notation: "compact" }).format(tokens)

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

/** How full the agent's context window is, so the developer knows when to start a fresh thread. */
export function ContextRing({ threadId }: { threadId: string }) {
  const context = useMessages(useShallow(latestContext(threadId)))
  if (context === null) return null
  return <Ring context={context} />
}

function Ring({ context }: { context: ContextWindow }) {
  const fraction = context.maxTokens > 0 ? Math.min(context.usedTokens / context.maxTokens, 1) : 0
  const percent = Math.round(fraction * 100)
  const used = formatTokens(context.usedTokens)
  const max = formatTokens(context.maxTokens)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="meter"
            tabIndex={0}
            aria-label={m.thread_context_window()}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={m.thread_context_value({ percent, used, max })}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
              fraction >= WARNING_FRACTION ? "text-attention" : "text-muted-foreground",
            )}
          >
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
          </span>
        }
      />
      <TooltipContent className="flex-col items-start gap-0.5 tabular-nums">
        <span className="font-medium">{m.thread_context_window()}</span>
        <span>{m.thread_context_used({ percent })}</span>
        <span>{m.thread_context_tokens({ used, max })}</span>
        <span className="opacity-70">{m.thread_context_as_of()}</span>
      </TooltipContent>
    </Tooltip>
  )
}
