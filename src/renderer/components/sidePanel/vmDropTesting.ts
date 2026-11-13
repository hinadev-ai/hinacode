import { act } from "react"
import type { HinacodeBridge, RpcRequestEncoded } from "../../../shared/contract.ts"
import type { Thread } from "../../../shared/domain.ts"
import type { RunningVm } from "./TinyVmView.tsx"

export const UNREADABLE_FILE = "from-another-app"

export const thread: Thread = {
  id: "t-1",
  projectId: "p-1",
  worktreeId: "w-1",
  title: "t",
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  accessMode: "full",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
}

export function stubRunningVm(vm: RunningVm) {
  const drops: Array<RpcRequestEncoded<"vm.files.drop">> = []
  const copying: Array<() => void> = []
  const never = new Promise<never>(() => undefined)
  const bridge: HinacodeBridge = {
    rpc: async (method, payload) => {
      if (method === "vm.get") return { result: vm }
      if (method === "vm.screen.open" || method === "vm.desktop.url") return never
      if (method === "vm.files.drop") {
        drops.push(payload as RpcRequestEncoded<"vm.files.drop">)
        await new Promise<void>((resolve) => copying.push(resolve))
        return { result: [] }
      }
      return { error: { tag: "NotStubbed", message: method } }
    },
    onEvent: () => () => undefined,
    pathForFile: (file) => (file.name === UNREADABLE_FILE ? "" : `/home/me/${file.name}`),
    liquidGlass: false,
    runtime: { kind: "desktop" },
  }
  Object.defineProperty(window, "hinacode", { value: bridge })
  return { drops, finishCopying: () => copying.splice(0).forEach((resolve) => resolve()) }
}

type DragType = "dragenter" | "dragover" | "dragleave" | "drop"

async function dispatchDrag(target: Element, type: DragType, transfer: DataTransfer) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  let accepted = true
  await act(() => {
    accepted = target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }))
  })
  return accepted
}

export function drag(target: Element, type: DragType, names: ReadonlyArray<string>) {
  const transfer = new DataTransfer()
  for (const name of names) transfer.items.add(new File(["x"], name, { type: "text/plain" }))
  return dispatchDrag(target, type, transfer)
}

export function dragText(target: Element, type: DragType) {
  const transfer = new DataTransfer()
  transfer.setData("text/plain", "hello")
  return dispatchDrag(target, type, transfer)
}
