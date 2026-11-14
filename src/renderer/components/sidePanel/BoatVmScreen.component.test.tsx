import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import "../../index.css"
import { TinyVmView } from "./TinyVmView.tsx"
import { drag, dragText, stubRunningVm, thread, UNREADABLE_FILE } from "./vmDropTesting.ts"

const vm = stubRunningVm({
  status: "running",
  provider: "boat",
  sandboxId: "sbx-1",
  template: "desktop",
  profile: "off",
  control: "user",
  agentWaiting: false,
})

const screen = async () => {
  await render(<TinyVmView thread={thread} />)
  const region = page.getByRole("region", { name: "Tiny VM screen" })
  await expect.element(region).toBeVisible()
  return region.element()
}

beforeEach(() => {
  vm.drops.splice(0)
})

const hint = page.getByText("Drop to copy into ~/Downloads in the VM")
const copying = page.getByText("Copying into the VM…")

test("files dragged over the Boat screen show where they land until the drag leaves it", async () => {
  const target = await screen()
  await drag(target, "dragenter", ["a.txt"])
  await expect.element(hint).toBeVisible()
  await drag(target, "dragenter", ["a.txt"])
  await drag(target, "dragleave", ["a.txt"])
  await expect.element(hint).toBeVisible()
  await drag(target, "dragleave", ["a.txt"])
  await expect.element(hint).not.toBeInTheDocument()
})

test("files dropped on the Boat screen copy into the VM by path, skipping any without one", async () => {
  const target = await screen()
  await drag(target, "dragenter", ["a.txt"])
  expect(await drag(target, "dragover", ["a.txt"])).toBe(false)
  expect(await drag(target, "drop", ["a.txt", UNREADABLE_FILE, "b.png"])).toBe(false)
  await expect.element(hint).not.toBeInTheDocument()
  await expect.element(copying).toBeVisible()
  expect(vm.drops).toEqual([{ threadId: "t-1", paths: ["/home/me/a.txt", "/home/me/b.png"] }])
  vm.finishCopying()
  await expect.element(copying).not.toBeInTheDocument()
})

test("dropping only items without a file path on the Boat screen explains why nothing copied", async () => {
  const target = await screen()
  await drag(target, "drop", [UNREADABLE_FILE])
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Those items have no file path on this machine, so they can't be copied into the VM.")
  expect(vm.drops).toEqual([])
})

test("text dragged over the Boat screen passes through to the desktop", async () => {
  const target = await screen()
  await dragText(target, "dragenter")
  expect(await dragText(target, "dragover")).toBe(true)
  expect(await dragText(target, "drop")).toBe(true)
  expect(hint.elements()).toEqual([])
  expect(vm.drops).toEqual([])
})
