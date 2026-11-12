import type { LinearIssue, PullRequest, PullRequestLink, Thread } from "@shared/domain.ts"
import { expect, it } from "vitest"
import type { Remote } from "@/stores/pull-requests"
import { pullRequestOverview, pullRequestReference, sortIssues } from "./overview"

const NOW = new Date(2026, 10, 8, 15).getTime()

const pr = (n: number) => `https://github.com/acme/app/pull/${n}`

const link = (threadId: string, n: number, createdAt: string, snapshot: object | null = null) =>
  ({ id: `${threadId}-${n}`, threadId, url: pr(n), createdAt, watch: snapshot && { snapshot } }) as PullRequestLink

const thread = (id: string, status = "idle") => ({ id, status }) as Thread

const ready = (n: number, fields: Partial<PullRequest>): Remote<PullRequest> => ({
  status: "ready",
  at: 0,
  value: { url: pr(n), number: n, title: `PR ${n}`, status: "open", checks: null, review: null, ...fields } as PullRequest,
})

it("groups active threads' pull requests by what they need, once each under the newest link", () => {
  const overview = pullRequestOverview(
    [
      link("t1", 1, "2026-10-20"),
      link("t2", 1, "2026-10-22"),
      link("t1", 2, "2026-10-21", { status: "open", checks: null, review: null, mergeable: "conflicting" }),
      link("t1", 3, "2026-10-19"),
      link("t1", 4, "2026-10-18"),
      link("t1", 5, "2026-10-17"),
      link("archived", 6, "2026-10-23"),
      link("t1", 7, "2026-10-16"),
    ],
    { t1: thread("t1"), t2: thread("t2"), archived: thread("archived", "archived") },
    {
      [pr(1)]: ready(1, { checks: "failing", review: "changesRequested" }),
      [pr(3)]: ready(3, { checks: "passing" }),
      [pr(4)]: ready(4, { status: "merged", checks: "failing" }),
      [pr(5)]: ready(5, { status: "closed" }),
    },
    NOW,
  )

  expect(overview.attention.map((row) => [row.url, row.threadId, row.needs])).toStrictEqual([
    [pr(1), "t2", ["checks", "changes"]],
    [pr(2), "t1", ["conflicts"]],
  ])
  expect(overview.open.map((row) => [row.url, row.pullRequest?.title ?? null])).toStrictEqual([
    [pr(3), "PR 3"],
    [pr(7), null],
  ])
  expect(overview.merged.map((row) => row.url)).toStrictEqual([pr(4)])
  expect(overview.urls).not.toContain(pr(6))
})

const issue = (id: string, type: string, priority: number, updatedAt: string) =>
  ({ id, identifier: id, title: id, url: "", state: { name: type, type }, priority, updatedAt }) as LinearIssue

it("lists each issue once, work in progress first, then by priority with no priority last", () => {
  const sorted = sortIssues([
    issue("backlog", "backlog", 1, "2026-10-24"),
    issue("todo-none", "unstarted", 0, "2026-10-24"),
    issue("todo-low", "unstarted", 4, "2026-10-20"),
    issue("doing", "started", 3, "2026-10-01"),
    issue("todo-low", "unstarted", 4, "2026-10-20"),
  ])
  expect(sorted.map((entry) => entry.id)).toStrictEqual(["doing", "todo-low", "todo-none", "backlog"])
})

it("names a pull request by its repository and number, before GitHub answers", () => {
  expect(pullRequestReference(pr(7))).toBe("acme/app #7")
  expect(pullRequestReference("https://example.com/pull/9")).toBe("#9")
})

it("numbers a GitLab merge request !N", () => {
  expect(pullRequestReference("https://gitlab.com/acme/app/-/merge_requests/5")).toBe("!5")
})

it("keeps a pull request GitHub could not resolve out of Open, unless a watch snapshot knows its state", () => {
  const failed: Remote<PullRequest> = { status: "error", message: "Not Found", at: 0 }
  const overview = pullRequestOverview(
    [link("t1", 1, "2026-10-20"), link("t1", 2, "2026-10-19", { status: "open", checks: null, review: null })],
    { t1: thread("t1") },
    { [pr(1)]: failed, [pr(2)]: failed },
    NOW,
  )

  expect(overview.open.map((row) => row.url)).toStrictEqual([pr(2)])
  expect(overview.unknown.map((row) => [row.url, row.error])).toStrictEqual([[pr(1), "Not Found"]])
})

it("splits merged pull requests at local midnight, newest merge first", () => {
  const at = (hour: number, day = 8) => new Date(2026, 10, day, hour).toISOString()
  const overview = pullRequestOverview(
    [link("t1", 1, "2026-10-20"), link("t1", 2, "2026-10-19"), link("t1", 3, "2026-10-18"), link("t1", 4, "2026-10-17")],
    { t1: thread("t1") },
    {
      [pr(1)]: ready(1, { status: "merged", mergedAt: at(9) }),
      [pr(2)]: ready(2, { status: "merged", mergedAt: at(23, 7) }),
      [pr(3)]: ready(3, { status: "merged", mergedAt: at(14) }),
      [pr(4)]: ready(4, { status: "merged", mergedAt: null }),
    },
    NOW,
  )

  expect(overview.mergedToday.map((row) => row.url)).toStrictEqual([pr(3), pr(1)])
  expect(overview.merged.map((row) => row.url)).toStrictEqual([pr(2), pr(4)])
})

it("says what an open pull request waits on, most urgent first", () => {
  const progress = (fields: Partial<PullRequest>, snapshot: object | null = null) =>
    pullRequestOverview([link("t1", 1, "2026-10-20", snapshot)], { t1: thread("t1") }, { [pr(1)]: ready(1, fields) }, NOW)
  const of = (fields: Partial<PullRequest>, snapshot: object | null = null) => {
    const overview = progress(fields, snapshot)
    return [...overview.attention, ...overview.open, ...overview.merged][0]?.progress
  }

  expect(of({ checks: "failing", mergeable: "conflicting" })).toBe("conflicts")
  expect(of({ checks: "failing", review: "changesRequested" })).toBe("checksFailing")
  expect(of({ checks: "pending", review: "changesRequested" })).toBe("changesRequested")
  expect(of({ checks: "pending", review: "approved", mergeable: "mergeable" })).toBe("checksRunning")
  expect(of({ checks: "passing", review: "reviewRequired", mergeable: "mergeable" })).toBe("reviewRequired")
  expect(of({ checks: "passing", review: "approved", mergeable: "mergeable" })).toBe("readyToMerge")
  expect(of({ checks: null, review: null, mergeable: "mergeable" })).toBe("readyToMerge")
  expect(of({ status: "draft", checks: "passing", mergeable: "mergeable" })).toBeNull()
  expect(of({ checks: "passing", mergeable: "unknown" })).toBeNull()
  expect(of({ status: "merged", checks: "failing" })).toBeNull()
})

it("trusts GitHub's mergeability over the watch snapshot unless GitHub has not computed it", () => {
  const snapshot = { status: "open", checks: null, review: null, mergeable: "conflicting" }
  const stale = pullRequestOverview(
    [link("t1", 1, "2026-10-20", snapshot)],
    { t1: thread("t1") },
    { [pr(1)]: ready(1, { mergeable: "mergeable" }) },
    NOW,
  )
  const pending = pullRequestOverview(
    [link("t1", 1, "2026-10-20", snapshot)],
    { t1: thread("t1") },
    { [pr(1)]: ready(1, { mergeable: "unknown" }) },
    NOW,
  )

  expect(stale.open.map((row) => row.progress)).toStrictEqual(["readyToMerge"])
  expect(pending.attention.map((row) => row.needs)).toStrictEqual([["conflicts"]])
})
