import { Schema } from "effect"
import { expect, test } from "vitest"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings } from "../../shared/domain.ts"
import "../index.css"
import { HighlightedCode } from "./HighlightedCode.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) =>
    method === "clientSettings.get"
      ? { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
      : { error: { tag: "NotStubbed", message: method } },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: "desktop",
}
Object.defineProperty(window, "hinacode", { value: bridge })

const code = "const answer = 42"

test("shows the code at once and colors it once the worker has tokenized it", async () => {
  const screen = await render(
    <pre>
      <HighlightedCode code={code} language="ts" />
    </pre>,
  )
  const block = screen.container.querySelector("pre")!
  expect(block.textContent).toBe(code)
  await expect.poll(() => block.querySelectorAll("span[style*='color']").length, { timeout: 10_000 }).toBeGreaterThan(1)
  expect(block.textContent).toBe(code)
})
