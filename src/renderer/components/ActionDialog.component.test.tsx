import { expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Project } from "../../shared/domain.ts"
import "../index.css"
import { ActionDialog } from "./ActionDialog.tsx"

const saves: Array<unknown> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "projects.update" || method === "settings.set") {
      saves.push(payload)
      return { result: undefined } as never
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "web" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("a whitespace-only command is not saved", async () => {
  await render(
    <ActionDialog
      project={{ id: "project", name: "app", kind: "folder", actions: [] } as unknown as Project}
      environment={null}
      target={{ scope: "project", index: null }}
      open
      onOpenChange={() => {}}
    />,
  )

  await userEvent.fill(page.getByLabelText("Name"), "Build")
  const command = page.getByLabelText("Command")
  await userEvent.fill(command, "   ")
  await page.getByRole("button", { name: "Save" }).click()

  await expect.element(command).toBeInvalid()
  expect(saves).toStrictEqual([])
})
