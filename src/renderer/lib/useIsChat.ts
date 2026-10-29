import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { projectsAtom } from "./rpc.ts"

export function useIsChat(projectId: string) {
  return AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []).some(
    (project) => project.id === projectId && project.kind === "chats",
  )
}
