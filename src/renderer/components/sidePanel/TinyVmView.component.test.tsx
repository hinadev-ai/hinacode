import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import "../../index.css"
import { ControlButton, type RunningVm, useVmDrop, VmScreen } from "./TinyVmView.tsx"

let runtime: HinacodeBridge["runtime"] = { kind: "web" }
const bridge: HinacodeBridge = {
  rpc: async (method) => ({ error: { tag: "NotStubbed", message: method } }),
  onEvent: () => () => undefined,
  pathForFile: () => "",
  liquidGlass: false,
  get runtime() {
    return runtime
  },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const tinyVm: RunningVm = {
  status: "running",
  provider: "sbx",
  sandboxId: "sbx-1",
  template: "desktop",
  profile: "off",
  control: "agent",
}

const boatVm: RunningVm = { ...tinyVm, provider: "boat" }

function BrowserVmScreen() {
  const drop = useVmDrop("t-1", () => undefined)
  return <VmScreen threadId="t-1" vm={tinyVm} onHandBack={() => undefined} onReconnect={() => undefined} drop={drop} />
}

test("a browser shows that the Tiny VM screen needs the desktop app instead of a dead stream", async () => {
  runtime = { kind: "web" }
  await render(<BrowserVmScreen />)
  await expect.element(page.getByText("The Tiny VM screen opens only in the desktop app.")).toBeVisible()
  expect(page.getByRole("region", { name: "Tiny VM screen" }).elements()).toEqual([])
})

const renderHandBack = (vm: RunningVm) =>
  render(
    <ControlButton
      threadId="t-1"
      vm={{ ...vm, control: "user", agentWaiting: false }}
      pending={false}
      run={() => undefined}
    />,
  )

test("the desktop app's Tiny VM hand-back button names the chord that hands back", async () => {
  runtime = { kind: "desktop" }
  await renderHandBack(tinyVm)
  await expect.element(page.getByRole("button", { name: /^Hand back .*Escape$/ })).toBeVisible()
})

test("the Boat hand-back button leaves out the chord its stream never receives", async () => {
  runtime = { kind: "desktop" }
  await renderHandBack(boatVm)
  await expect.element(page.getByRole("button", { name: "Hand back", exact: true })).toBeVisible()
})

test("a browser's Tiny VM hand-back button leaves out the chord, because no screen is there to take it", async () => {
  runtime = { kind: "web" }
  await renderHandBack(tinyVm)
  await expect.element(page.getByRole("button", { name: "Hand back", exact: true })).toBeVisible()
})
