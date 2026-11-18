import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import type { VmControl } from "../../../shared/domain.ts"
import "../../index.css"
import { TinyVmView } from "./TinyVmView.tsx"
import { thread } from "./vmDropTesting.ts"

const u16 = (value: number) => [(value >> 8) & 255, value & 255]
const u32 = (value: number) => [(value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255]
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

const serverVersion = new Uint8Array(ascii("RFB 003.008\n"))
const securityTypesNoneOnly = new Uint8Array([1, 1])
const securityOk = new Uint8Array(u32(0))
const trueColor32 = [32, 24, 0, 1, ...u16(255), ...u16(255), ...u16(255), 16, 8, 0, 0, 0, 0]
const serverInit = new Uint8Array([...u16(1280), ...u16(800), ...trueColor32, ...u32(3), ...ascii("sbx")])
const serverCutText = (text: string) => new Uint8Array([3, 0, 0, 0, ...u32(text.length), ...ascii(text)])

const vmWith = (control: VmControl) => {
  const base = { status: "running", provider: "sbx", sandboxId: "sbx-1", template: "desktop", profile: "off" } as const
  return control === "user" ? { ...base, control, agentWaiting: false } : { ...base, control }
}

type Listener = Parameters<HinacodeBridge["onEvent"]>[0]

const streams: Array<string> = []
const listeners = new Set<Listener>()
const replies = [securityTypesNoneOnly, securityOk, serverInit]
const copied: Array<string> = []

const push = (event: Parameters<Listener>[0]) => {
  for (const listener of listeners) listener(event)
}

const serve = (data: Uint8Array) => push({ type: "vm.screen.data", streamId: streams.at(-1) ?? "", data })

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "vm.get") return { result: vmWith("agent") }
    if (method === "vm.screen.open") streams.push(Reflect.get(Object(payload), "streamId"))
    if (method === "vm.screen.send") {
      const reply = replies.shift()
      if (reply !== undefined) queueMicrotask(() => serve(reply))
    }
    if (method === "vm.screen.open" || method === "vm.screen.send" || method === "vm.screen.close") {
      return { result: undefined }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })
Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: async (text: string) => {
      copied.push(text)
    },
  },
})

test("text copied in the VM reaches this machine's clipboard only while the user has control and focus", async () => {
  await render(<TinyVmView thread={thread} />)
  await expect.poll(() => streams.length).toBe(1)
  serve(serverVersion)
  await expect.element(page.getByText("Connecting to the screen…")).not.toBeInTheDocument()
  await expect.element(page.getByText("Agent has control")).toBeVisible()

  serve(serverCutText("written while the agent drives"))
  expect(copied).toEqual([])

  push({ type: "vm.updated", threadId: thread.id, vm: vmWith("user") })
  await expect.element(page.getByText("You have control")).toBeVisible()
  const canvas = page.getByRole("region", { name: "Tiny VM screen" }).element().querySelector("canvas")
  canvas?.blur()
  serve(serverCutText("written while the user works elsewhere"))
  expect(copied).toEqual([])

  canvas?.focus()
  serve(serverCutText("copied in the vm"))
  await expect.poll(() => copied).toEqual(["copied in the vm"])
})
