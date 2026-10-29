import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import { needsAttention, rowState } from "../../shared/threadStatus.ts"
import { environmentOf } from "../lib/environments.ts"
import { callPromise, projectsAtom, pullRequestAttentionsAtom } from "../lib/rpc.ts"
import { useNow } from "../lib/useNow.ts"
import { useBackgroundTasks } from "../stores/backgroundTasks.ts"
import { usePullRequests } from "../stores/pullRequests.ts"
import { selectAwakeThreads, useThreads } from "../stores/threads.ts"
import { useUnseen } from "../stores/unseen.ts"

export function DockBadge() {
  const threads = useThreads(useShallow(selectAwakeThreads(useNow())))
  const unseen = useUnseen((state) => state.byThreadId)
  const background = useBackgroundTasks((state) => state.byThreadId)
  const links = usePullRequests((state) => state.byThreadId)
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const pullRequests = useAtomValue(
    pullRequestAttentionsAtom(
      threads.map((thread) => [
        environmentOf(projects.find((project) => project.id === thread.projectId)),
        (links[thread.id] ?? []).map((link) => link.url),
      ]),
    ),
  )
  const count = threads.filter((thread, index) =>
    needsAttention(
      rowState(thread.status, (background[thread.id]?.length ?? 0) > 0, unseen[thread.id], pullRequests[index]),
    ),
  ).length

  useEffect(() => {
    void callPromise("app.setBadgeCount", { count })
  }, [count])
  return null
}
