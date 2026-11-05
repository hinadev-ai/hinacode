import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { projectIconAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { FolderIcon } from "@hinacode/icons"

export function ProjectIcon({
  projectId,
  letterOf,
  className = "size-4",
}: {
  projectId: string
  letterOf?: string
  className?: string
}) {
  const icon = AsyncResult.getOrElse(useAtomValue(projectIconAtom(projectId)), () => null)
  if (icon === null && letterOf !== undefined) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-sm bg-sidebar-accent text-2xs font-medium text-sidebar-foreground uppercase",
          className,
        )}
      >
        {Array.from(letterOf)[0]}
      </span>
    )
  }
  return icon === null ? (
    <FolderIcon aria-hidden className={cn("shrink-0 text-muted-foreground", className)} />
  ) : (
    <img src={icon} alt="" className={cn("shrink-0 rounded-sm object-contain", className)} />
  )
}
