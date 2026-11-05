import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import "../../index.css"
import { type RunningVm, VmScreen } from "./TinyVmView.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) => ({ error: { tag: "NotStubbed", message: method } }),
  onEvent: () => () => undefined,
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
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

test("a browser shows that the Tiny VM screen needs the desktop app instead of a dead stream", async () => {
  await render(
    <VmScreen
      threadId="t-1"
      vm={tinyVm}
      onHandBack={() => undefined}
      onReconnect={() => undefined}
      onDropFiles={() => undefined}
      dropping={false}
    />,
  )
  await expect.element(page.getByText("The Tiny VM screen opens only in the desktop app.")).toBeVisible()
  expect(page.getByRole("region", { name: "Tiny VM screen" }).elements()).toEqual([])
})
