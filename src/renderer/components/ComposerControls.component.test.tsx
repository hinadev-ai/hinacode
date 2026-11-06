import { beforeEach, expect, test, vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { ModelInfo } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { pickerProviders, ThreadPicker } from "./ComposerControls.tsx"

const model = (id: string): ModelInfo => ({
  id,
  label: id,
  provider: "claude",
  efforts: [],
  defaultEffort: null,
  fastMode: false,
  autoMode: false,
})

const account = (id: string) => ({
  id,
  provider: "claude",
  name: `A very long account name ${id}`,
  configDir: `/tmp/${id}`,
  binary: "claude",
})

const rpc = vi.fn(async (method: string, payload?: unknown) => {
  if (method === "agents.account") return { result: { type: "apiKey" } }
  if (method === "accounts.list") return { result: ["one", "two", "three", "four"].map(account) }
  if (method === "threads.switchAccount")
    return { result: { ...thread, accountId: (payload as { accountId: string }).accountId } }
  if (method === "threads.update") return { result: thread }
  if (method === "models.list") return { result: [model("first"), model("second"), model("third")] }
  return { error: { tag: "NotStubbed", message: method } }
})
vi.stubGlobal("hinacode", { rpc, onEvent: () => () => {}, pathForFile: () => "", liquidGlass: false })

const thread: Thread = {
  id: "thread-1",
  projectId: "p-1",
  worktreeId: null,
  title: "t",
  provider: "claude",
  model: "second",
  effort: null,
  fastMode: false,
  userSkills: true,
  accessMode: "full",
  accountId: "one",
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
}

beforeEach(() => {
  useThreads.setState({ byId: {} } as never)
})

const openPicker = async () => {
  await render(<ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />)
  await page.getByRole("button", { name: /second/ }).click()
  await expect.element(page.getByRole("option", { name: "first" })).toBeVisible()
}

const highlighted = () => document.querySelector("[role=option][data-highlighted]")?.textContent
const selectedTab = () => document.querySelector("[role=tab][aria-selected=true]")?.textContent

test.each(["claude", "codex", "muse", "opencode"] as const)(
  "keeps the agents in a fixed order on a %s thread",
  async (provider) => {
    await render(<ThreadPicker thread={{ ...thread, provider, accountId: null }} canSwitchAgent onError={() => {}} />)
    await page.getByRole("button", { name: /second/ }).click()
    await expect.element(page.getByRole("tab").first()).toBeVisible()
    const agents = [...document.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)
    const position = (name: string) => agents.findIndex((label) => label?.includes(name))
    const others = ["Claude Code", "Codex", "Muse Code", "opencode"].map(position).filter((index) => index !== -1)
    expect(others).toEqual(others.toSorted((a, b) => a - b))
  },
)

test("keeps the thread's own agent when it is signed out, and hides other agents that are", () => {
  expect(pickerProviders("muse", ["opencode", "claude"])).toStrictEqual(["claude", "muse", "opencode"])
})

test("fills the space above the trigger up to 520px, whatever the model count", async () => {
  await render(
    <div className="pt-[60vh]">
      <ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />
    </div>,
  )
  await page.getByRole("button", { name: /second/ }).click()
  await expect.element(page.getByRole("option", { name: "first" })).toBeVisible()
  const popup = document.querySelector<HTMLElement>("[data-slot=popover-content]")!
  const trigger = page.getByRole("button", { name: /second/ }).element()
  const available = Number.parseFloat(getComputedStyle(popup).getPropertyValue("--available-height"))
  expect(available).toBeGreaterThan(100)
  expect(Math.abs(popup.offsetHeight - Math.min(520, available))).toBeLessThan(1)
  expect(popup.dataset["side"]).toBe("top")
  expect(trigger.getBoundingClientRect().top - popup.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(0)
})

test("focuses the search box on the current model and moves through the models with the arrow keys", async () => {
  await openPicker()
  await expect.element(page.getByRole("combobox", { name: "Search models" })).toHaveFocus()
  await expect.poll(highlighted).toContain("second")
  const check = page.getByRole("option", { name: "second" }).element().querySelector("svg")!
  expect(getComputedStyle(check).visibility).toBe("visible")
  await userEvent.keyboard("{ArrowDown}")
  await expect.poll(highlighted).toContain("third")
  await userEvent.keyboard("{ArrowUp}{ArrowUp}")
  await expect.poll(highlighted).toContain("first")
})

test("typing filters the models instead of running shortcuts", async () => {
  rpc.mockClear()
  await openPicker()
  await userEvent.keyboard("thi")
  await expect.poll(() => document.querySelectorAll("[role=option]").length).toBe(1)
  await expect.poll(highlighted).toContain("third")
  await userEvent.keyboard("lz")
  await expect.element(page.getByText("No matching models")).toBeVisible()
  expect(selectedTab()).toContain("one")
  expect(rpc.mock.calls.some(([method]) => method === "threads.update")).toBe(false)
})

test("Alt+L moves to the next account and keeps its tab in view", async () => {
  await openPicker()
  for (const name of ["two", "three", "four"]) {
    await userEvent.keyboard("{Alt>}l{/Alt}")
    await expect.poll(selectedTab).toContain(name)
  }
  await expect.element(page.getByRole("combobox", { name: "Search models" })).toHaveValue("")
  const list = document.querySelector("[data-slot=tabs-list]")!
  await expect
    .poll(
      () =>
        document.querySelector("[role=tab][aria-selected=true]")!.getBoundingClientRect().right -
        list.getBoundingClientRect().right,
    )
    .toBeLessThanOrEqual(2)
})

test("Alt+L starts the next tab without the previous tab's highlight and keeps the same search box", async () => {
  await openPicker()
  const search = page.getByRole("combobox", { name: "Search models" }).element()
  await userEvent.keyboard("{ArrowDown}")
  await expect.poll(highlighted).toContain("third")
  await userEvent.keyboard("{Alt>}l{/Alt}")
  await expect.poll(selectedTab).toContain("two")
  await expect.poll(highlighted).toBeUndefined()
  expect(page.getByRole("combobox", { name: "Search models" }).element()).toBe(search)
  expect(document.activeElement).toBe(search)
})

test("an IME Enter keeps the picker open", async () => {
  await openPicker()
  const imeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  Object.defineProperties(imeEnter, { keyCode: { value: 229 }, which: { value: 229 } })
  page.getByRole("combobox", { name: "Search models" }).element().dispatchEvent(imeEnter)
  await userEvent.keyboard("{ArrowDown}")
  await expect.poll(highlighted).toContain("third")
})

test("switching to another account selects its first model right away", async () => {
  rpc.mockClear()
  await openPicker()
  await userEvent.keyboard("{Alt>}l{/Alt}")
  await expect
    .poll(() => rpc.mock.calls.find(([method]) => method === "threads.switchAccount")?.[1])
    .toMatchObject({ id: "thread-1", accountId: "two" })
  await expect
    .poll(() => rpc.mock.calls.find(([method]) => method === "threads.update")?.[1])
    .toMatchObject({ id: "thread-1", model: "first" })
})

test("skips a thread's unlisted model when it picks the first one", async () => {
  rpc.mockClear()
  await render(
    <ThreadPicker thread={{ ...thread, id: "thread-2", model: "retired" }} canSwitchAgent onError={() => {}} />,
  )
  await page.getByRole("button", { name: /retired/ }).click()
  await expect.element(page.getByRole("option", { name: "first" })).toBeVisible()
  await userEvent.keyboard("{Alt>}l{/Alt}")
  await expect
    .poll(() => rpc.mock.calls.find(([method]) => method === "threads.update")?.[1])
    .toMatchObject({ model: "first" })
})

test("Enter picks the highlighted model and closes", async () => {
  rpc.mockClear()
  await openPicker()
  await userEvent.keyboard("thi{Enter}")
  await expect.element(page.getByRole("option", { name: "first" })).not.toBeInTheDocument()
  await expect
    .poll(() => rpc.mock.calls.find(([method]) => method === "threads.update")?.[1])
    .toMatchObject({ id: "thread-1", model: "third" })
})

test("Enter right after opening keeps the current model", async () => {
  rpc.mockClear()
  await openPicker()
  await userEvent.keyboard("{Enter}")
  await expect.element(page.getByRole("option", { name: "first" })).not.toBeInTheDocument()
  expect(rpc.mock.calls.some(([method]) => method === "threads.update")).toBe(false)
})

test("opens only the side chat's picker when the shortcut fires from the side chat", async () => {
  await render(
    <>
      <ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />
      <div data-sidechat>
        <input aria-label="Side input" />
        <ThreadPicker thread={{ ...thread, sideOf: "thread-1" }} canSwitchAgent onError={() => {}} />
      </div>
    </>,
  )
  await page.getByRole("textbox", { name: "Side input" }).click()
  useUi.getState().requestPicker("model")
  expect(useUi.getState().pickerRequest?.inSidechat).toBe(true)
  await expect.poll(() => document.querySelectorAll("[role=option]").length).toBe(3)
})
