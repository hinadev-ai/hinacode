import { beforeEach, expect, test, vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { ModelInfo } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { ThreadPicker } from "./ComposerControls.tsx"

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

let signedOut: ReadonlyArray<string> = []
const accountResult = (payload: unknown) => ({
  result: signedOut.includes((payload as { provider: string }).provider) ? { type: "signedOut" } : { type: "apiKey" },
})

const rpc = vi.fn(async (method: string, payload?: unknown) => {
  if (method === "agents.account") return accountResult(payload)
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
  signedOut = []
  useThreads.setState({ byId: {} } as never)
})

const openPicker = async () => {
  await render(<ThreadPicker thread={thread} canSwitchAgent onError={() => {}} />)
  await page.getByRole("button", { name: /second/ }).click()
  await expect.element(page.getByRole("button", { name: "first" })).toBeVisible()
}

const focused = () => document.activeElement?.textContent

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

test("keeps the thread's own agent when it is signed out, and hides other agents that are", async () => {
  signedOut = ["claude", "muse"]
  await render(
    <ThreadPicker thread={{ ...thread, provider: "claude", accountId: null }} canSwitchAgent onError={() => {}} />,
  )
  await page.getByRole("button", { name: /second/ }).click()
  await expect.element(page.getByRole("tab", { name: "Codex" })).toBeVisible()
  const labels = [...document.querySelectorAll("[role=tab]")].map((tab) => tab.textContent).join()
  expect(labels).not.toContain("Muse")
  expect(labels).toContain("Codex")
  expect(document.querySelectorAll("[role=tab]").length).toBeGreaterThan(2)
})

test("moves through the models with the arrow keys", async () => {
  await openPicker()
  await userEvent.keyboard("{ArrowDown}")
  expect(focused()).toContain("second")
  await userEvent.keyboard("{ArrowDown}")
  expect(focused()).toContain("third")
  await userEvent.keyboard("{ArrowDown}")
  expect(focused()).toContain("first")
  await userEvent.keyboard("{ArrowUp}")
  expect(focused()).toContain("third")
})

test("highlights the first model of the next account and keeps its tab in view", async () => {
  await openPicker()
  const selectedTab = () => document.querySelector("[role=tab][aria-selected=true]")
  for (const name of ["two", "three", "four"]) {
    await userEvent.keyboard("l")
    await expect.poll(() => selectedTab()?.textContent).toContain(name)
  }
  await expect.poll(focused).toContain("first")
  const list = document.querySelector("[data-slot=tabs-list]")!
  await expect
    .poll(() => selectedTab()!.getBoundingClientRect().right - list.getBoundingClientRect().right)
    .toBeLessThanOrEqual(2)
})

test("switching to another account selects its first model right away", async () => {
  rpc.mockClear()
  await openPicker()
  await userEvent.keyboard("l")
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
  await expect.element(page.getByRole("button", { name: "first" })).toBeVisible()
  await userEvent.keyboard("l")
  await expect
    .poll(() => rpc.mock.calls.find(([method]) => method === "threads.update")?.[1])
    .toMatchObject({ model: "first" })
})

test("Enter switches to the highlighted model of the other account", async () => {
  rpc.mockClear()
  await openPicker()
  await userEvent.keyboard("l")
  await expect.poll(focused).toContain("first")
  await userEvent.keyboard("{Enter}")
  await expect.element(page.getByRole("button", { name: "first" })).not.toBeInTheDocument()
  await expect.poll(() => rpc.mock.calls.some(([method]) => method === "threads.switchAccount")).toBe(true)
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
  await expect.poll(() => document.querySelectorAll("[data-model-row]").length).toBe(3)
})
