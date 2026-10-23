import type { ReactNode } from "react"
import { cn } from "../lib/utils.ts"

const rowClassName = "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left text-muted-foreground"

/**
 * One line of the indicator. With `onClick` the line is a button that recedes like a tool row until the user
 * reaches for it. `actions` stay outside it, so they can be buttons of their own.
 */
export function ActivityRow({
  children,
  actions,
  onClick,
  expanded,
  label,
}: {
  children: ReactNode
  actions?: ReactNode
  onClick?: () => void
  /** Set when the row opens and closes a list below it. */
  expanded?: boolean
  label?: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 py-0.5 text-xs">
      {onClick ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={label}
          onClick={onClick}
          className={cn(
            rowClassName,
            "pressable outline-none hover:bg-muted/50 hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground",
          )}
        >
          {children}
        </button>
      ) : (
        <div aria-label={label} className={rowClassName}>
          {children}
        </div>
      )}
      {actions}
    </div>
  )
}
