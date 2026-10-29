import type { PullRequest, PullRequestLink, Thread } from "@shared/domain.ts"
import { expect, it } from "vitest"
import type { Remote } from "@/stores/pull-requests"
import { pullRequestOverview } from "./overview"

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
