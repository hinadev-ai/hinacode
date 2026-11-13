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

let listedModels = [model("first"), model("second"), model("third")]
let codexModels: ReadonlyArray<ModelInfo> | null = null
const accountLimits = [
  {
    provider: "claude",
    accountId: "one",
    limits: {
      windows: [{ window: { kind: "session" }, usedPercent: 40, resetsAt: null }],
      readAt: "2026-11-01T00:00:00.000Z",
    },
  },
]

const rpc = vi.fn(async (method: string, payload?: unknown) => {
  if (method === "agents.account") return { result: { type: "apiKey" } }
  if (method === "accounts.list") return { result: ["one", "two", "three", "four"].map(account) }
  if (method === "threads.switchAccount")
    return { result: { ...thread, accountId: (payload as { accountId: string }).accountId } }
  if (method === "threads.update") return { result: thread }
  if (method === "limits.list") return { result: accountLimits }
  if (method === "models.list")
    return {
      result: (payload as { provider: string }).provider === "codex" ? (codexModels ?? listedModels) : listedModels,
    }
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

const popover = () => document.querySelector<HTMLElement>("[data-slot=popover-content]")!

test("fills the space above the trigger up to 520px with a long model list", async () => {
  const shortList = listedModels
  listedModels = Array.from({ length: 40 }, (_, index) => model(index === 1 ? "second" : `model-${index}`))
  try {
    await render(
      <div className="pt-[60vh]">
        <ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />
      </div>,
    )
    await page.getByRole("button", { name: /second/ }).click()
    await expect.element(page.getByRole("option", { name: "model-39" })).toBeInTheDocument()
    const trigger = page.getByRole("button", { name: /second/ }).element()
    const available = Number.parseFloat(getComputedStyle(popover()).getPropertyValue("--available-height"))
    expect(available).toBeGreaterThan(100)
    expect(Math.abs(popover().offsetHeight - Math.min(520, available))).toBeLessThan(1)
    expect(popover().dataset["side"]).toBe("top")
    expect(trigger.getBoundingClientRect().top - popover().getBoundingClientRect().bottom).toBeGreaterThanOrEqual(0)
  } finally {
    listedModels = shortList
  }
})

test("fits a short model list and keeps its height while the search filters it", async () => {
  await render(
    <div className="pt-[80vh]">
      <ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />
    </div>,
  )
  await page.getByRole("button", { name: /second/ }).click()
  await expect.element(page.getByRole("option", { name: "third" })).toBeVisible()
  const list = page.getByRole("listbox", { name: "Model" }).element()
  const rows = [...list.querySelectorAll<HTMLElement>("[role=option]")]
  const lastRow = rows.at(-1)!.getBoundingClientRect()
  expect(list.getBoundingClientRect().bottom - lastRow.bottom).toBeLessThan(lastRow.height / 2)
  const height = popover().offsetHeight
  expect(height).toBeLessThan(
    Math.min(520, Number.parseFloat(getComputedStyle(popover()).getPropertyValue("--available-height"))),
  )
  await userEvent.keyboard("thi")
  await expect.poll(() => document.querySelectorAll("[role=option]").length).toBe(1)
  expect(popover().offsetHeight).toBe(height)
  await userEvent.keyboard("zzz")
  await expect.element(page.getByText("No matching models")).toBeVisible()
  expect(popover().offsetHeight).toBe(height)
})

test("keeps its height when leaving an account tab that shows its usage", async () => {
  await render(
    <div className="pt-[80vh]">
      <ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />
    </div>,
  )
  await page.getByRole("button", { name: /second/ }).click()
  await expect.element(page.getByText("40% used")).toBeVisible()
  const height = popover().offsetHeight
  await page.getByRole("tab", { name: "Codex" }).click()
  await expect.poll(selectedTab).toContain("Codex")
  await expect.element(page.getByRole("option", { name: "third" })).toBeVisible()
  expect(popover().offsetHeight).toBe(height)
})

test("grows for a longer agent's list and does not shrink back while open", async () => {
  codexModels = Array.from({ length: 8 }, (_, index) => ({ ...model(`codex-${index}`), provider: "codex" }))
  try {
    await render(
      <div className="pt-[80vh]">
        <ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />
      </div>,
    )
    await page.getByRole("button", { name: /second/ }).click()
    await expect.element(page.getByRole("option", { name: "third" })).toBeVisible()
    const short = popover().offsetHeight
    await page.getByRole("tab", { name: "Codex" }).click()
    await expect.element(page.getByRole("option", { name: "codex-7" })).toBeVisible()
    const tall = popover().offsetHeight
    expect(tall).toBeGreaterThan(short)
    await page.getByRole("tab", { name: /account name one/ }).click()
    await expect.element(page.getByRole("option", { name: "third" })).toBeVisible()
    expect(popover().offsetHeight).toBe(tall)
    await userEvent.keyboard("{Escape}")
    await page.getByRole("button", { name: /second/ }).click()
    await expect.element(page.getByRole("option", { name: "third" })).toBeVisible()
    expect(popover().offsetHeight).toBe(short)
  } finally {
    codexModels = null
  }
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

test("lists the models again each time it opens, so a provider signed in meanwhile shows up", async () => {
  await openPicker()
  await userEvent.keyboard("{Escape}")
  listedModels = [...listedModels, model("fourth")]
  try {
    await page.getByRole("button", { name: /second/ }).click()
    await expect.element(page.getByRole("option", { name: "fourth" })).toBeVisible()
  } finally {
    listedModels = listedModels.slice(0, 3)
  }
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

const accessToggles = () =>
  [...document.querySelectorAll(`[aria-label="Access"] button`)].map((toggle) => toggle.textContent)

test("labels Claude's auto slot Accept edits on a model without auto mode", async () => {
  await openPicker()
  await expect.poll(accessToggles).toStrictEqual(["Supervised", "Accept edits", "Full access"])
})

test("labels a Muse thread's access modes with Muse's permission profiles", async () => {
  await render(
    <ThreadPicker thread={{ ...thread, provider: "muse", accountId: null }} canSwitchAgent onError={() => {}} />,
  )
  await page.getByRole("button", { name: /second/ }).click()
  await expect.poll(accessToggles).toStrictEqual(["Ask me", "Auto-review", "Unrestricted"])
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
