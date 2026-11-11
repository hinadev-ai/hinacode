import { expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../../shared/contract.ts"
import type { ThreadDevices } from "../../../../shared/device.ts"
import type { Thread } from "../../../../shared/domain.ts"
import "../../../index.css"
import { DEVICE_LIST_TAB, useDeviceTabs } from "../../../stores/deviceTabs.ts"
import { DeviceTabStrip } from "./DeviceTabStrip.tsx"

const devices: ThreadDevices = ["a", "b", "c"].map((id) => ({
  phase: "failed",
  deviceId: `android:${id}`,
  name: id.toUpperCase(),
  owned: false,
  message: "offline",
}))

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "device.get") return { result: devices } as never
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const shownAfter = async (threadId: string, key: string) => {
  useDeviceTabs.getState().select(threadId, DEVICE_LIST_TAB)
  await render(<DeviceTabStrip thread={{ id: threadId } as Thread} />)
  await userEvent.tab()
  await expect.element(page.getByRole("tab", { name: "A" })).toHaveFocus()
  await userEvent.keyboard(`{${key}}`)
  return useDeviceTabs.getState().selected[threadId]
}

test("with the device list shown, ArrowRight moves from the first tab to the second", async () => {
  expect(await shownAfter("right", "ArrowRight")).toBe("android:b")
})

test("with the device list shown, ArrowLeft wraps from the first tab to the last", async () => {
  expect(await shownAfter("left", "ArrowLeft")).toBe("android:c")
})
