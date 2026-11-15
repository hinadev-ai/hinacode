import { useState } from "react"
import { expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { DirectorySuggestion } from "../../shared/domain.ts"
import "../index.css"
import type { EnvironmentId } from "../lib/rpc.ts"
import { PathInput } from "./PathInput.tsx"

const tree: Record<string, ReadonlyArray<DirectorySuggestion>> = {
  "~/": [
    { path: "~/code", name: "code", repository: false },
    { path: "~/Documents", name: "Documents", repository: false },
  ],
  "~/code/": [
    { path: "~/code/hinacode", name: "hinacode", repository: true },
    { path: "~/code/notes", name: "notes", repository: false },
  ],
}

const completions = (path: string) => {
  const cut = path.lastIndexOf("/") + 1
  const prefix = path.slice(cut).toLowerCase()
  return (tree[path.slice(0, cut)] ?? []).filter((entry) => entry.name.toLowerCase().startsWith(prefix))
}

const requested: Array<unknown> = []
const otherMachine = Promise.withResolvers<ReadonlyArray<DirectorySuggestion>>()
const slowFolder = Promise.withResolvers<ReadonlyArray<DirectorySuggestion>>()

const bridge: HinacodeBridge = {
  rpc: async (method, payload, environment) => {
    if (method === "fs.completeDirectory") {
      requested.push(payload)
      if (environment === "other-machine") return { result: await otherMachine.promise }
      if ((payload as { path: string }).path === "~/slow") return { result: await slowFolder.promise }
      return { result: completions((payload as { path: string }).path) }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

function Harness({ environment = null }: { environment?: EnvironmentId }) {
  const [value, setValue] = useState("")
  return (
    <>
      <label htmlFor="path">Folder</label>
      <PathInput id="path" value={value} onChange={setValue} environment={environment} />
    </>
  )
}

const input = () => page.getByLabelText("Folder")
const option = (name: string) => page.getByRole("option", { name: new RegExp(`^${name}`) })

test("typing a path shows matching folders", async () => {
  await render(<Harness />)
  await input().fill("~/")

  await expect.element(option("code")).toBeVisible()
  await expect.element(option("Documents")).toBeVisible()

  await input().fill("~/d")
  await expect.element(option("Documents")).toBeVisible()
  await expect.element(option("code")).not.toBeInTheDocument()
})

test("picking a folder appends a separator and keeps the list open", async () => {
  await render(<Harness />)
  await input().fill("~/co")
  await option("code").click()

  await expect.element(input()).toHaveValue("~/code/")
  await expect.element(option("hinacode")).toBeVisible()
})

test("picking a repository sets its path and closes the list", async () => {
  await render(<Harness />)
  await input().fill("~/code/")
  await expect.element(page.getByRole("option", { name: "hinacode Git repository" })).toBeVisible()
  await option("hinacode").click()

  await expect.element(input()).toHaveValue("~/code/hinacode")
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument()
})

test("Tab accepts the first suggestion like a shell", async () => {
  await render(<Harness />)
  await input().fill("~/co")
  await expect.element(option("code")).toBeVisible()
  await userEvent.keyboard("{Tab}")

  await expect.element(input()).toHaveValue("~/code/")
  await expect.element(input()).toHaveFocus()
})

test("Tab accepts the suggestion the arrow keys highlighted", async () => {
  await render(<Harness />)
  await input().fill("~/")
  await expect.element(option("Documents")).toBeVisible()
  await userEvent.keyboard("{ArrowDown}{ArrowDown}")
  await expect.element(option("Documents")).toHaveAttribute("data-highlighted")
  await userEvent.keyboard("{Tab}")

  await expect.element(input()).toHaveValue("~/Documents/")
})

test("a GitHub owner/repo never asks for suggestions", async () => {
  requested.length = 0
  await render(<Harness />)
  await input().fill("kjj6198/hinacode")
  await input().fill("kjj6198/hinacode2")

  expect(requested).toEqual([])
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument()
})

test("folders that arrive after the field lost focus stay closed", async () => {
  requested.length = 0
  await render(
    <>
      <Harness />
      <label htmlFor="next">Next</label>
      <input id="next" />
    </>,
  )
  await input().fill("~/slow")
  await expect.poll(() => requested).toContainEqual({ path: "~/slow" })
  await page.getByLabelText("Next").click()

  slowFolder.resolve([{ path: "~/slower", name: "slower", repository: false }])
  await slowFolder.promise
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument()

  await input().click()
  await expect.element(option("slower")).toBeVisible()
})

test("switching machines drops the previous machine's folders", async () => {
  const screen = await render(<Harness />)
  await input().fill("~/")
  await expect.element(option("code")).toBeVisible()

  await screen.rerender(<Harness environment="other-machine" />)
  await expect.element(option("code")).not.toBeInTheDocument()

  otherMachine.resolve([{ path: "~/projects", name: "projects", repository: false }])
  await expect.element(option("projects")).toBeVisible()
})
