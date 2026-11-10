import type { Thread } from "../../shared/domain.ts"

interface ThreadEntry {
  readonly thread: Thread
  readonly nested: boolean
}

export function nestChildren(threads: ReadonlyArray<Thread>): ReadonlyArray<ThreadEntry> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const listedParentOf = (thread: Thread) => {
    const parent = thread.parentId === null ? undefined : byId.get(thread.parentId)
    return parent?.parentId === null ? parent.id : undefined
  }
  const childrenOf = Map.groupBy(threads, listedParentOf)
  return (childrenOf.get(undefined) ?? []).flatMap((thread) => [
    { thread, nested: false },
    ...(childrenOf.get(thread.id) ?? []).map((child) => ({ thread: child, nested: true })),
  ])
}
