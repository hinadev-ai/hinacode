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

let answer: Promise<unknown> = Promise.resolve([])
const rpc = () => answer.then((result) => ({ result }))
Object.assign(globalThis, { window: { hinacode: { rpc } } })
const { loadAllPullRequestsAtom, usePullRequests } = await import("./pullRequests.ts")

const registry = AtomRegistry.make()

const settled = () =>
  vi.waitFor(() => expect(registry.get(loadAllPullRequestsAtom)).toMatchObject({ _tag: "Success", waiting: false }))

afterEach(() => {
  answer = Promise.resolve([])
  usePullRequests.setState({ byThreadId: {} })
})

test("a reload drops the links of a thread whose last pull request was unlinked", async () => {
  answer = Promise.resolve([link("t1", 1)])
  const unmount = registry.mount(loadAllPullRequestsAtom)
  registry.refresh(loadAllPullRequestsAtom)
  await settled()
  expect(usePullRequests.getState().byThreadId["t1"]).toEqual([link("t1", 1)])

  answer = Promise.resolve([])
  registry.refresh(loadAllPullRequestsAtom)
  await settled()

  expect(usePullRequests.getState().byThreadId["t1"] ?? []).toEqual([])
  unmount()
})

test("a reload keeps a link pushed while it was in flight", async () => {
  const pending = Promise.withResolvers<unknown>()
  answer = pending.promise
  const unmount = registry.mount(loadAllPullRequestsAtom)
  registry.refresh(loadAllPullRequestsAtom)

  usePullRequests.getState().replace("t2", [link("t2", 2)])
  pending.resolve([])
  await settled()

  expect(usePullRequests.getState().byThreadId["t2"]).toEqual([link("t2", 2)])
  unmount()
})
