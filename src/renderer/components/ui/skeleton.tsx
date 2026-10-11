import type { ComponentProps } from "react"
import { cn } from "cn"

function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

const rowKeys = ["a", "b", "c", "d", "e"] as const

/**
 * Placeholder rows for a list that usually loads in well under a second. It fades in after 150ms,
 * so a fast load never flashes it. `label` is what assistive tech announces while it shows.
 */
function SkeletonList({
  label,
  rows = 3,
  rowClassName,
  className,
}: {
  label: string
  rows?: 1 | 2 | 3 | 4 | 5
  rowClassName?: string
  className?: string
}) {
  return (
    <output
      aria-label={label}
      className={cn(
        "flex flex-col gap-2 transition-opacity delay-150 duration-200 ease-out starting:opacity-0",
        className,
      )}
    >
      {rowKeys.slice(0, rows).map((key) => (
        <Skeleton key={key} className={rowClassName} />
      ))}
    </output>
  )
}

export { Skeleton, SkeletonList }
