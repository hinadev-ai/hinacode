import { cn } from "../lib/utils.ts"

export function ShimmerText({ text, className }: { text: string; className?: string }) {
  return (
    <p data-text={text} className={cn("text-shimmer", className)}>
      {text}
    </p>
  )
}
