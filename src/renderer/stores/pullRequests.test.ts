import { afterEach, expect, test, vi } from "@effect/vitest"
import { AtomRegistry } from "effect/reactivity"
import type { Environments, EnvironmentStatus, Project, PullRequestLink, Thread } from "../../shared/domain.ts"

const link = (threadId: string, n: number): PullRequestLink => ({
  id: `${threadId}-${n}`,
  threadId,
  url: `https://github.com/o/r/pull/${n}`,
  createdAt: "2026-11-12T00:00:00.000Z",
  watch: null,
})

const cloud = (id: string, status: EnvironmentStatus): Environments["clouds"][number] => ({
  id,
  name: id,
  host: `${id}.example`,
  port: 7777,
  relay: null,
  source: "pairing",
  createdAt: "2026-11-12T00:00:00.000Z",
  status,
  lastSeenAt: null,
})

const project = (id: string, environmentId: string): Project => ({
  id,
  name: id,
  rootPath: `/${id}`,
  setupScript: null,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  environmentId,
  linearReview: false,
  kind: "folder",
  actions: [],
})

const threadIn = (id: string, projectId: string) => ({ id, projectId }) as Thread

let answers: Record<string, unknown> = {}
const rpc = (method: string) => Promise.resolve({ result: answers[method] })
Object.assign(globalThis, { window: { hinacode: { rpc } } })
const { loadAllPullRequestsAtom, usePullRequests } = await import("./pullRequests.ts")
const { projectsAtom } = await import("../lib/rpc.ts")
const { useThreads } = await import("./threads.ts")

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
  useThreads.setState({ byId: {} })
})

test("a reload drops the links of a thread whose last pull request was unlinked", async () => {
  answers = { "pullRequests.all": [link("t1", 1)], "environments.list": { clouds: [] } }
  const unmount = registry.mount(loadAllPullRequestsAtom)
  await load()
  expect(usePullRequests.getState().byThreadId["t1"]).toEqual([link("t1", 1)])

  answers = { ...answers, "pullRequests.all": [] }
  await load()

  expect(usePullRequests.getState().byThreadId["t1"] ?? []).toEqual([])
  unmount()
})

test("a reload keeps the links of threads on a cloud that is not connected", async () => {
  answers = {
    "projects.list": [project("p-up", "up"), project("p-down", "down")],
    "environments.list": { clouds: [cloud("up", "connected"), cloud("down", "offline")] },
    "pullRequests.all": [],
  }
  useThreads.setState({ byId: { "on-up": threadIn("on-up", "p-up"), "on-down": threadIn("on-down", "p-down") } })
  const unmountProjects = registry.mount(projectsAtom)
  registry.refresh(projectsAtom)
  await vi.waitFor(() => expect(registry.get(projectsAtom)).toMatchObject({ _tag: "Success", waiting: false }))
  usePullRequests.setState({ byThreadId: { "on-up": [link("on-up", 1)], "on-down": [link("on-down", 2)] } })
  const unmount = registry.mount(loadAllPullRequestsAtom)

  await load()

  expect(usePullRequests.getState().byThreadId).toEqual({ "on-down": [link("on-down", 2)] })
  unmount()
  unmountProjects()
})
