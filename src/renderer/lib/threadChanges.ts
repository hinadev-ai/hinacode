import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useEffect, useRef } from "react"
import type { ChangesScope, Thread } from "../../shared/domain.ts"
import { threadChangesAtom } from "./rpc.ts"

export const patchLineCounts = (patch: string) => {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

export function useThreadChanges(thread: Thread, scope: ChangesScope) {
  const changesAtom = threadChangesAtom(`${thread.id}\n${scope}`)
  const changes = useAtomValue(changesAtom)
  const refresh = useAtomRefresh(changesAtom)

  const lastStatus = useRef(thread.status)
  useEffect(() => {
    if (lastStatus.current === thread.status) return
    lastStatus.current = thread.status
    refresh()
  }, [thread.status, refresh])

  return { changes, refresh }
}
