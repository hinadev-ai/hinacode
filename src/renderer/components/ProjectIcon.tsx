import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { RiFolder3Line } from "react-icons/ri"
import { projectIconAtom } from "../lib/rpc.ts"

/** The project's own favicon, or a folder when it has none. */
export function ProjectIcon({ projectId }: { projectId: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(projectIconAtom(projectId)), () => null)
  return icon === null ? (
    <RiFolder3Line aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <img src={icon} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
  )
}
