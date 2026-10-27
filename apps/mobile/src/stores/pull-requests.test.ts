import type { PullRequest, PullRequestLink } from "@shared/domain.ts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { flush, type PendingCall } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({
  call: (await import("./testing")).fakeCall(calls),
  onEvent: () => () => {},
  RpcError: Error,
}))

const { DETAIL_MAX_AGE, SUMMARY_MAX_AGE, usePullRequests } = await import("./pull-requests")

const URL_A = "https://github.com/acme/app/pull/1"
const URL_B = "https://github.com/acme/app/pull/2"

const link = (id: string, threadId: string, url: string, watched = false) =>
  ({
    id,
    threadId,
    url,
    createdAt: "2026-10-16T00:00:00.000Z",
    watch: watched ? { snapshot: { status: "open", checks: "failing", review: null, mergeable: "mergeable" } } : null,
  }) as unknown as PullRequestLink

const pullRequest = (url: string, checks: PullRequest["checks"] = "passing") =>
  ({
    url,
    number: 1,
    title: "Fix",
    status: "open",
    checks,
    review: "approved",
    mergeable: "conflicting",
  }) as PullRequest

const requests = (method: string) => calls.filter((pending) => pending.method === method)
const answer = async (method: string, value: unknown) => {
  for (const pending of requests(method)) pending.resolve(value)
  calls.length = 0
  await flush()
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(0)
  calls.length = 0
  usePullRequests.setState({ linksByThread: {}, summaries: {}, pullRequests: {}, details: {} })
})

afterEach(() => vi.useRealTimers())

it("groups every thread's links, oldest first", async () => {
  const loading = usePullRequests.getState().load()
  await answer("pullRequests.all", [link("1", "t1", URL_A), link("2", "t2", URL_B), link("3", "t1", URL_B)])
  await loading
  const { linksByThread } = usePullRequests.getState()
  expect(linksByThread.t1.map((existing) => existing.id)).toEqual(["1", "3"])
  expect(linksByThread.t2.map((existing) => existing.id)).toEqual(["2"])
})

it("replaces a thread's links with a push, and keeps a push that lands during a load", async () => {
  const loading = usePullRequests.getState().load()
  usePullRequests.getState().replace("t1", [link("9", "t1", URL_B)])
  await answer("pullRequests.all", [link("1", "t1", URL_A), link("2", "t2", URL_B)])
  await loading
  expect(usePullRequests.getState().linksByThread.t1.map((existing) => existing.id)).toEqual(["9"])

  usePullRequests.getState().replace("t2", [])
  expect(usePullRequests.getState().linksByThread.t2).toEqual([])
})

it("keeps a push that lands while one thread's links are read", async () => {
  const loading = usePullRequests.getState().loadThread("t1")
  usePullRequests.getState().replace("t1", [link("a", "t1", URL_A), link("b", "t1", URL_B)])
  await answer("pullRequests.list", [link("a", "t1", URL_A)])
  await loading
  expect(usePullRequests.getState().linksByThread["t1"]?.map((existing) => existing.url)).toEqual([URL_A, URL_B])
})

it("takes a watched link's summary from its snapshot without asking GitHub", () => {
  usePullRequests.getState().replace("t1", [link("1", "t1", URL_A, true)])
  vi.setSystemTime(SUMMARY_MAX_AGE * 2)
  usePullRequests.getState().ensureSummary(URL_A)
  expect(calls).toEqual([])
  expect(usePullRequests.getState().summaries[URL_A]).toMatchObject({
    status: "ready",
    value: { status: "open", checks: "failing", review: null, mergeable: "mergeable" },
  })
})

it("shares one read between concurrent requests for the same pull request", async () => {
  usePullRequests.getState().ensureSummary(URL_A)
  usePullRequests.getState().ensureSummary(URL_A)
  const card = usePullRequests.getState().loadPullRequest(URL_A)
  expect(requests("github.pullRequest")).toHaveLength(1)
  expect(usePullRequests.getState().summaries[URL_A]).toEqual({ status: "loading" })

  await answer("github.pullRequest", pullRequest(URL_A))
  await card
  expect(usePullRequests.getState().summaries[URL_A]).toMatchObject({
    status: "ready",
    value: { status: "open", checks: "passing", review: "approved", mergeable: "conflicting" },
  })
})

it("reads a pull request again only after a minute, and keeps the last value while it does", async () => {
  usePullRequests.getState().ensureSummary(URL_A)
  await answer("github.pullRequest", pullRequest(URL_A))

  vi.setSystemTime(SUMMARY_MAX_AGE - 1)
  usePullRequests.getState().ensureSummary(URL_A)
  expect(calls).toEqual([])

  vi.setSystemTime(SUMMARY_MAX_AGE)
  usePullRequests.getState().ensureSummary(URL_A)
  expect(requests("github.pullRequest")).toHaveLength(1)
  expect(usePullRequests.getState().summaries[URL_A].status).toBe("ready")

  await answer("github.pullRequest", pullRequest(URL_A, "failing"))
  expect(usePullRequests.getState().summaries[URL_A]).toMatchObject({ value: { checks: "failing" } })
})

it("reports a failed read and retries it after the same interval", async () => {
  const loading = usePullRequests.getState().loadDetail(URL_A)
  requests("github.pullRequestDetail")[0].reject(new Error("gh is not signed in"))
  calls.length = 0
  await loading
  expect(usePullRequests.getState().details[URL_A]).toEqual({ status: "error", message: "gh is not signed in", at: 0 })
  expect(usePullRequests.getState().summaries[URL_A].status).toBe("error")

  void usePullRequests.getState().loadDetail(URL_A)
  expect(calls).toEqual([])
  vi.setSystemTime(DETAIL_MAX_AGE)
  const retry = usePullRequests.getState().loadDetail(URL_A)
  expect(requests("github.pullRequestDetail")).toHaveLength(1)
  await answer("github.pullRequestDetail", pullRequest(URL_A))
  await retry
  expect(usePullRequests.getState().details[URL_A].status).toBe("ready")
})

it("reads a detail again when forced, and ignores the read it superseded", async () => {
  const first = usePullRequests.getState().loadDetail(URL_A)
  const older = requests("github.pullRequestDetail")[0]
  calls.length = 0
  const forced = usePullRequests.getState().loadDetail(URL_A, { force: true })
  await answer("github.pullRequestDetail", { ...pullRequest(URL_A), status: "merged" })
  await forced
  older.resolve({ ...pullRequest(URL_A), status: "open" })
  await first
  await flush()
  expect(usePullRequests.getState().details[URL_A]).toMatchObject({ status: "ready", value: { status: "merged" } })
})
