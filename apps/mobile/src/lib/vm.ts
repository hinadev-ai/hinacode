import { useAtomValue } from "@effect/atom-react"
import type { ThreadVm } from "@shared/domain.ts"
import { AsyncResult } from "effect/reactivity"
import { rpcFamily } from "./remote"

const threadVm = rpcFamily("vm.get", {
  refreshOn: (event, { threadId }) => event.type === "vm.updated" && event.threadId === threadId,
})

export const useThreadVm = (threadId: string): ThreadVm | null => {
  const result = useAtomValue(threadVm({ threadId }))
  return AsyncResult.isSuccess(result) ? result.value : null
}

export const handOverRequest = (vm: ThreadVm | null) =>
  vm?.status === "running" && vm.control === "user" ? vm.request : undefined
