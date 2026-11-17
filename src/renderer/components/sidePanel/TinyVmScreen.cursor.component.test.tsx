import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import "../../index.css"
import { TinyVmView } from "./TinyVmView.tsx"
import { stubRunningVm, thread } from "./vmDropTesting.ts"

stubRunningVm({
  status: "running",
  provider: "sbx",
  sandboxId: "sbx-1",
  template: "desktop",
  profile: "off",
  control: "agent",
})

test("the pointer stays visible over the Tiny VM screen while the agent has control", async () => {
  await render(<TinyVmView thread={thread} />)
  const region = page.getByRole("region", { name: "Tiny VM screen" })
  await expect.element(region).toBeVisible()
  const canvas = region.element().querySelector("canvas")
  expect(canvas).not.toBeNull()
  expect(getComputedStyle(canvas!).cursor).toBe("default")
})
