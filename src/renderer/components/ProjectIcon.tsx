import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { projectIconAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { FolderIcon } from "./icons/FolderIcon.tsx"

export function ProjectIcon({ projectId, className = "size-4" }: { projectId: string; className?: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(projectIconAtom(projectId)), () => null)
  return icon === null ? (
    <FolderIcon aria-hidden className={cn("shrink-0 text-muted-foreground", className)} />
  ) : (
    <img src={icon} alt="" className={cn("shrink-0 rounded-sm object-contain", className)} />
  )
}
