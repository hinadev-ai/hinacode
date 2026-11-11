import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { projectsAtom } from "./rpc.ts"

export function useHasNoWorkspace(projectId: string) {
  return AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []).some(
    (project) => project.id === projectId && project.kind !== "folder",
  )
}
