import { cn } from "cn"
import type { EnvironmentStatus } from "../../shared/domain.ts"
import { statusDot, statusLabel } from "../lib/environments.ts"

export function EnvironmentStatusText({ status }: { status: EnvironmentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusDot[status])} />
      {statusLabel[status]()}
    </span>
  )
}
