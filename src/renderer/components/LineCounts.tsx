import { m } from "../paraglide/messages.js"

export function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono tabular-nums">
      <span aria-hidden className="text-vcs-added">
        +{added}
      </span>{" "}
      <span aria-hidden className="text-destructive">
        −{removed}
      </span>
      <span className="sr-only">{m.diff_line_counts({ added, removed })}</span>
    </span>
  )
}
