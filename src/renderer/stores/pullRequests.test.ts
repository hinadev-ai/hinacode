import { afterEach, expect, test, vi } from "@effect/vitest"
import { AtomRegistry } from "effect/reactivity"
import type { PullRequestLink } from "../../shared/domain.ts"

const link = (threadId: string, n: number): PullRequestLink => ({
  id: `${threadId}-${n}`,
  threadId,
  url: `https://github.com/o/r/pull/${n}`,
  createdAt: "2026-11-12T00:00:00.000Z",
  watch: null,
})

let answers: Record<string, unknown> = {}
const rpc = (method: string) => Promise.resolve({ result: answers[method] })
Object.assign(globalThis, { window: { hinacode: { rpc } } })
const { loadAllPullRequestsAtom, usePullRequests } = await import("./pullRequests.ts")

const registry = AtomRegistry.make()

const load = async () => {
  registry.refresh(loadAllPullRequestsAtom)
  await vi.waitFor(() =>
    expect(registry.get(loadAllPullRequestsAtom)).toMatchObject({ _tag: "Success", waiting: false }),
  )
}

afterEach(() => {
  answers = {}
  usePullRequests.setState({ byThreadId: {} })
})

test("a reload drops the links of a thread whose last pull request was unlinked", async () => {
  answers = { "pullRequests.all": [link("t1", 1)] }
  const unmount = registry.mount(loadAllPullRequestsAtom)
  await load()
  expect(usePullRequests.getState().byThreadId["t1"]).toEqual([link("t1", 1)])

  answers = { ...answers, "pullRequests.all": [] }
  await load()

  expect(usePullRequests.getState().byThreadId["t1"] ?? []).toEqual([])
  unmount()
})
