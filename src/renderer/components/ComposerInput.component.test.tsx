import { Schema } from "effect"
import { Suspense } from "react"
import { expect, test } from "vitest"
import { cdp, page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings } from "../../shared/domain.ts"
import "../index.css"
import { ComposerInput } from "./ComposerInput.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) =>
    method === "clientSettings.get"
      ? { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
      : { error: { tag: "NotStubbed", message: method } },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
}
Object.defineProperty(window, "hinacode", { value: bridge })

const placeholder = "Ask anything"

const shownPlaceholder = () => {
  const line = document.querySelector(".cm-line")
  return line === null ? null : getComputedStyle(line, "::before").content
}

test("hides the placeholder while an IME composes the first character", async () => {
  await render(
    <Suspense>
      <ComposerInput
        value=""
        onValueChange={() => {}}
        commands={[]}
        files={[]}
        threads={{ sameMachine: [], otherMachines: [] }}
        projectId="project"
        placeholder={placeholder}
        aria-label="Message"
        onEnter={() => {}}
      />
    </Suspense>,
  )
  await page.getByRole("combobox", { name: "Message" }).click()
  await expect.poll(shownPlaceholder).toBe(`"${placeholder}"`)

  await cdp().send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 })
  await expect.poll(shownPlaceholder).toBe("none")
})
