import type { ReactNode } from "react"
import { RiClaudeFill, RiMetaFill, RiOpenaiFill } from "react-icons/ri"
import { CheckIcon, XCircleFillIcon } from "../icons.ts"
import type { DemoCopy } from "./copy.ts"
import type { ProviderId, ThreadStatus } from "./engine.ts"

const providers = {
  claude: { Icon: RiClaudeFill, color: "text-provider-claude", label: "provider_claude" },
  codex: { Icon: RiOpenaiFill, color: "text-ink", label: "provider_codex" },
  muse: { Icon: RiMetaFill, color: "text-provider-muse", label: "provider_muse" },
} as const

export function providerName(copy: DemoCopy, provider: ProviderId) {
  return copy[providers[provider].label]
}

export function ProviderMark({ provider, className = "" }: { provider: ProviderId; className?: string }) {
  const { Icon, color } = providers[provider]
  return <Icon aria-hidden className={`shrink-0 ${color} ${className}`} />
}

export function StatusGlyph({ status, unseen, copy }: { status: ThreadStatus; unseen: boolean; copy: DemoCopy }) {
  const label = {
    "needs-you": copy.site_demo_needs_you,
    running: copy.thread_status_running,
    failing: copy.pr_checks_failing,
    done: copy.site_demo_done,
  }[status]
  return (
    <span className="relative grid size-3.5 shrink-0 place-items-center" title={label}>
      <span className="sr-only">{label}</span>
      {status === "running" && <span aria-hidden className="running-dot size-2 rounded-full bg-coral" />}
      {status === "needs-you" && <span aria-hidden className="size-2 rounded-full bg-attention" />}
      {status === "failing" && <XCircleFillIcon aria-hidden className="size-3.5 text-danger" />}
      {status === "done" &&
        (unseen ? (
          <span aria-hidden className="size-2 rounded-full bg-teal" />
        ) : (
          <CheckIcon aria-hidden className="size-3 text-ink-soft" />
        ))}
    </span>
  )
}

const buttonBase =
  "pressable inline-flex h-7 items-center justify-center gap-1.5 text-xs font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
const rectangle = `${buttonBase} rounded-lg px-2.5`

export const buttonStyles = {
  primary: `${rectangle} bg-coral-deep text-paper hover:bg-coral-deeper`,
  send: `${buttonBase} size-7 rounded-full bg-coral-deep text-paper hover:bg-coral-deeper`,
  secondary: `${rectangle} bg-paper text-ink shadow-[0_0_0_1px_var(--color-line-strong)] hover:bg-muted`,
  ghost: `${rectangle} text-ink-soft hover:bg-muted hover:text-ink`,
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-ink-soft">{title}</h3>
      {children}
    </section>
  )
}

export function segmentsOf(text: string, locale: string) {
  return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(text)]
}

export const STREAM_STEP_MS = 26

export function StreamText({ text, animate, locale }: { text: string; animate: boolean; locale: string }) {
  if (!animate) return text
  return segmentsOf(text, locale).map((part, index) => (
    <span key={part.index} className="stream-word" style={{ animationDelay: `${index * STREAM_STEP_MS}ms` }}>
      {part.segment}
    </span>
  ))
}
