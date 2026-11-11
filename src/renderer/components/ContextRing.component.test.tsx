import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Message } from "../../shared/domain.ts"
import "../index.css"
import { useMessages } from "../stores/messages.ts"
import { ContextRing } from "./ContextRing.tsx"

const breakdownRequests: Array<unknown> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "threads.contextBreakdown") {
      breakdownRequests.push(payload)
      return { result: null } as never
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("a magpie thread asks its Claude harness for the breakdown", async () => {
  const reply = { role: "assistant", parts: [], usage: { context: { usedTokens: 50_000, maxTokens: 200_000 } } }
  useMessages.setState({
    byThread: {
      magpie: {
        status: "ready",
        messages: [reply as unknown as Message],
        approvals: [],
        questions: [],
        secretRequests: [],
      },
    },
  })

  await render(<ContextRing threadId="magpie" provider="magpie" />)
  await page.getByRole("button", { name: /25% used/ }).click()

  await expect.element(page.getByText(/reports what fills it/)).toBeVisible()
  expect(breakdownRequests).toStrictEqual([{ threadId: "magpie" }])
})
