import { describe, expect, test } from "@effect/vitest"
import type { PullRequestDetail, PullRequestWatchSnapshot } from "../../shared/domain.ts"
import { allWatchEventKinds } from "../../shared/domain.ts"
import { snapshotFromDetail, watchEvents, watchMessage, watchStoppedMessage } from "./pullRequestWatch.ts"

const detail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  url: "https://github.com/o/r/pull/7",
  number: 7,
  title: "Fix the thing",
  status: "open",
  checks: "pending",
  review: null,
  author: "octocat",
  headRefName: "feat/fix",
  baseRefName: "main",
  additions: 1,
  deletions: 0,
  body: "",
  baseRef: "main",
  headRef: "feat/fix",
  head: "abc1234",
  mergeable: "mergeable",
  changedFiles: 1,
  checkRuns: [],
  ...overrides,
})

const failingDetail = (names: ReadonlyArray<string>, overrides: Partial<PullRequestDetail> = {}) =>
  detail({
    checks: "failing",
    checkRuns: names.map((name) => ({ name, status: "failing" as const, url: `https://ci.example/${name}` })),
    ...overrides,
  })

const snapshot = (overrides: Partial<PullRequestWatchSnapshot> = {}): PullRequestWatchSnapshot => ({
  status: "open",
  checks: "pending",
  review: null,
  mergeable: "mergeable",
  head: "abc1234",
  failingChecks: [],
  ...overrides,
})

describe("snapshotFromDetail", () => {
  test("collects the failing check names and the head", () => {
    expect(snapshotFromDetail(failingDetail(["CI / test", "CI / lint"]))).toMatchObject({
      checks: "failing",
      head: "abc1234",
      failingChecks: ["CI / test", "CI / lint"],
    })
  })
})

describe("watchEvents", () => {
  test("a fresh watch reports checks that already failed", () => {
    expect(watchEvents(null, snapshotFromDetail(failingDetail(["CI / test"])), allWatchEventKinds)).toStrictEqual([
      "checksFailed",
    ])
  })

  test("a fresh watch stays quiet while checks run and review is only required", () => {
    const quiet = snapshotFromDetail(detail({ review: "reviewRequired", mergeable: "unknown" }))
    expect(watchEvents(null, quiet, allWatchEventKinds)).toStrictEqual([])
  })

  test("a fresh watch reports a pull request that is already green", () => {
    expect(watchEvents(null, snapshot({ checks: "passing" }), allWatchEventKinds)).toStrictEqual(["checksPassed"])
  })

  test("the same snapshot twice is not news", () => {
    const told = snapshotFromDetail(failingDetail(["CI / test"]))
    expect(watchEvents(told, told, allWatchEventKinds)).toStrictEqual([])
  })

  test("a second check failing is news even though checks were already failing", () => {
    const told = snapshotFromDetail(failingDetail(["CI / test"]))
    const now = snapshotFromDetail(failingDetail(["CI / test", "CI / lint"]))
    expect(watchEvents(told, now, allWatchEventKinds)).toStrictEqual(["checksFailed"])
  })

  test("a push makes the same check failing news again", () => {
    const told = snapshotFromDetail(failingDetail(["CI / test"]))
    const pushed = snapshotFromDetail(failingDetail(["CI / test"], { head: "def5678" }))
    expect(watchEvents(told, pushed, allWatchEventKinds)).toStrictEqual(["checksFailed"])
  })

  test("passing after failing fires once, then stays quiet on the same head", () => {
    const failing = snapshotFromDetail(failingDetail(["CI / test"]))
    const passing = snapshot({ checks: "passing" })
    expect(watchEvents(failing, passing, allWatchEventKinds)).toStrictEqual(["checksPassed"])
    expect(watchEvents(passing, passing, allWatchEventKinds)).toStrictEqual([])
  })

  test("a review decision only fires when it becomes approved or changes requested", () => {
    const told = snapshot({ review: "reviewRequired" })
    expect(watchEvents(told, snapshot({ review: "changesRequested" }), allWatchEventKinds)).toStrictEqual([
      "reviewChanged",
    ])
    expect(watchEvents(told, snapshot({ review: "approved" }), allWatchEventKinds)).toStrictEqual(["reviewChanged"])
    expect(watchEvents(told, snapshot({ review: null }), allWatchEventKinds)).toStrictEqual([])
  })

  test("conflicting fires on the edge into conflict, not while it stays conflicted", () => {
    expect(watchEvents(snapshot(), snapshot({ mergeable: "conflicting" }), allWatchEventKinds)).toStrictEqual([
      "conflicting",
    ])
    const conflicted = snapshot({ mergeable: "conflicting" })
    expect(watchEvents(conflicted, conflicted, allWatchEventKinds)).toStrictEqual([])
  })

  test("merging suppresses every other event of the same poll", () => {
    const merged = snapshot({ status: "merged", checks: "passing", review: "approved" })
    expect(watchEvents(snapshot(), merged, allWatchEventKinds)).toStrictEqual(["mergedOrClosed"])
  })

  test("the interest set filters what fires", () => {
    const now = snapshotFromDetail(failingDetail(["CI / test"], { review: "changesRequested" }))
    expect(watchEvents(null, now, ["reviewChanged"])).toStrictEqual(["reviewChanged"])
    expect(watchEvents(null, now, [])).toStrictEqual([])
  })
})

describe("watchMessage", () => {
  test("names the newly failing checks with their log links", () => {
    const found = failingDetail(["CI / test"])
    const message = watchMessage(found, null, ["checksFailed"])
    expect(message).toContain("https://github.com/o/r/pull/7")
    expect(message).toContain("CI / test")
    expect(message).toContain("https://ci.example/CI / test")
    expect(message).not.toContain("merge the pull request")
  })

  test("only lists failures the thread has not been told about", () => {
    const told = snapshotFromDetail(failingDetail(["CI / test"]))
    const found = failingDetail(["CI / test", "CI / lint"])
    const message = watchMessage(found, told, ["checksFailed"])
    expect(message).toContain("CI / lint")
    expect(message).not.toContain("CI / test")
  })

  test("a merged pull request says watching has ended", () => {
    const message = watchMessage(detail({ status: "merged" }), snapshot(), ["mergedOrClosed"])
    expect(message).toContain("merged")
    expect(message).toContain("watching has ended")
  })
})

describe("watchStoppedMessage", () => {
  test("carries the reason so the thread never looks silently unwatched", () => {
    const message = watchStoppedMessage("https://github.com/o/r/pull/7", "GitHub could not be read")
    expect(message).toContain("https://github.com/o/r/pull/7")
    expect(message).toContain("GitHub could not be read")
    expect(message).toContain("watch_pull_request")
  })
})
