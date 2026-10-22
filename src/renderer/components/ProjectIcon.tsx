import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { RiFolder3Line } from "react-icons/ri"
import { projectIconAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"

/** The project's own favicon, or a folder when it has none. */
export function ProjectIcon({ projectId, className = "size-4" }: { projectId: string; className?: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(projectIconAtom(projectId)), () => null)
  return icon === null ? (
    <RiFolder3Line aria-hidden className={cn("shrink-0 text-muted-foreground", className)} />
  ) : (
    <img src={icon} alt="" className={cn("shrink-0 rounded-sm object-contain", className)} />
  )
}
