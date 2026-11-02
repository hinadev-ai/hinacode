import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useEffect, useRef } from "react"
import type { ChangesScope, Thread } from "../../shared/domain.ts"
import { threadChangesAtom } from "./rpc.ts"

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
