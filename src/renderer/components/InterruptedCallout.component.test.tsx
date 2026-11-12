import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import "../index.css"
import { InterruptedCallout } from "./InterruptedCallout.tsx"

const calls: Array<{ readonly method: string; readonly payload: unknown }> = []
let refusal: string | null = null

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    calls.push({ method, payload })
    if (method !== "threads.resume") return { error: { tag: "NotStubbed", message: method } }
    return refusal === null ? { result: undefined } : { error: { tag: "AgentError", message: refusal } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("Resume asks main to resume this thread, and shows why it refused", async () => {
  render(<InterruptedCallout threadId="thread-1" />)
  await expect.element(page.getByRole("heading", { name: "Interrupted by a restart" })).toBeVisible()

  await page.getByRole("button", { name: "Resume" }).click()
  await expect.poll(() => calls).toStrictEqual([{ method: "threads.resume", payload: { id: "thread-1" } }])

  refusal = "This thread was not interrupted"
  await page.getByRole("button", { name: "Resume" }).click()
  await expect.element(page.getByRole("alert")).toHaveTextContent("The agent failed: This thread was not interrupted")
})
