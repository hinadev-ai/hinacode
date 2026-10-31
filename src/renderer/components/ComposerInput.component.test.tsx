import { Schema } from "effect"
import { Suspense, useState } from "react"
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

let value = ""

function Harness() {
  const [text, setText] = useState("")
  return (
    <ComposerInput
      value={text}
      onValueChange={(next) => {
        value = next
        setText(next)
      }}
      commands={[]}
      files={[]}
      threads={{ sameMachine: [], otherMachines: [] }}
      projectId="project"
      placeholder={placeholder}
      aria-label="Message"
      onEnter={() => {}}
    />
  )
}

const renderComposer = () =>
  render(
    <Suspense>
      <Harness />
    </Suspense>,
  )

const type = (text: string) => cdp().send("Input.insertText", { text })

const press = async (key: "Enter" | "Backspace", modifiers = 0) => {
  const code = { Enter: 13, Backspace: 8 }[key]
  const event = { key, code: key, windowsVirtualKeyCode: code, modifiers }
  await cdp().send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event })
  await cdp().send("Input.dispatchKeyEvent", { type: "keyUp", ...event })
}
const shift = 8

test("continues a list on shift+enter and leaves it on an empty item", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()

  await type("1. first")
  await press("Enter", shift)
  await type("second")
  await press("Enter", shift)
  await expect.poll(() => value).toBe("1. first\n2. second\n3. ")

  await press("Enter", shift)
  await type("- dot")
  await press("Enter", shift)
  await expect.poll(() => value).toBe("1. first\n2. second\n- dot\n- ")
  await expect.poll(() => document.querySelectorAll(".cm-line")[3]?.textContent).toBe("• ")

  await press("Backspace")
  await expect.poll(() => value).toBe("1. first\n2. second\n- dot\n")
})

test("hides the placeholder while an IME composes the first character", async () => {
  await renderComposer()
  await page.getByRole("combobox", { name: "Message" }).click()
  await expect.poll(shownPlaceholder).toBe(`"${placeholder}"`)

  await cdp().send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 })
  await expect.poll(shownPlaceholder).toBe("none")
})
