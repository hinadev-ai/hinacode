import { describe, expect, test } from "@effect/vitest"
import type { Changes } from "./domain.ts"
import type { ShipReportInput, ShipReportPullRequest } from "./shipReport.ts"
import { deriveShipReport, shipReportMarkdown } from "./shipReport.ts"

const pullRequest = (extra: Partial<ShipReportPullRequest> = {}): ShipReportPullRequest => ({
  url: "https://github.com/o/r/pull/1",
  number: 1,
  title: "First",
  status: "open",
  checks: "passing",
  review: "approved",
  mergeable: "mergeable",
  ...extra,
})

const changes = (patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context"): Changes => ({
  files: [{ path: "src/a.ts", status: "modified" }],
  patch,
})

const input = (extra: Partial<ShipReportInput> = {}): ShipReportInput => ({
  threadStatus: "idle",
  changes: changes(),
  pullRequests: [pullRequest()],
  ...extra,
})

describe("deriveShipReport verdicts", () => {
  test("failing checks on an open pull request block", () => {
    const report = deriveShipReport(input({ pullRequests: [pullRequest({ checks: "failing" })] }))
    expect(report.verdict).toBe("blocked")
    expect(report.reasons).toStrictEqual(["checksFailing"])
  })

  test("a conflicting draft pull request blocks", () => {
    const report = deriveShipReport(
      input({ pullRequests: [pullRequest({ status: "draft", mergeable: "conflicting" })] }),
    )
    expect(report.verdict).toBe("blocked")
    expect(report.reasons).toStrictEqual(["conflicting"])
  })

  test("changes requested block", () => {
    const report = deriveShipReport(input({ pullRequests: [pullRequest({ review: "changesRequested" })] }))
    expect(report.verdict).toBe("blocked")
    expect(report.reasons).toStrictEqual(["changesRequested"])
  })

  test("blocked beats working", () => {
    const report = deriveShipReport(
      input({ threadStatus: "running", pullRequests: [pullRequest({ checks: "failing" })] }),
    )
    expect(report.verdict).toBe("blocked")
    expect(report.reasons).toStrictEqual(["checksFailing", "threadRunning"])
  })

  test("a running thread is working", () => {
    const report = deriveShipReport(input({ threadStatus: "running" }))
    expect(report.verdict).toBe("working")
    expect(report.reasons).toStrictEqual(["threadRunning"])
  })

  test("a thread awaiting approval is working", () => {
    const report = deriveShipReport(input({ threadStatus: "awaiting_approval" }))
    expect(report.verdict).toBe("working")
    expect(report.reasons).toStrictEqual(["awaitingApproval"])
  })

  test("pending checks pend", () => {
    const report = deriveShipReport(input({ pullRequests: [pullRequest({ checks: "pending" })] }))
    expect(report.verdict).toBe("pending")
    expect(report.reasons).toStrictEqual(["checksPending"])
  })

  test("a required review pends", () => {
    const report = deriveShipReport(input({ pullRequests: [pullRequest({ review: "reviewRequired" })] }))
    expect(report.verdict).toBe("pending")
    expect(report.reasons).toStrictEqual(["reviewRequired"])
  })

  test("working beats pending", () => {
    const report = deriveShipReport(
      input({ threadStatus: "running", pullRequests: [pullRequest({ checks: "pending" })] }),
    )
    expect(report.verdict).toBe("working")
  })

  test("no files and no pull requests is empty", () => {
    const report = deriveShipReport(input({ changes: { files: [], patch: "" }, pullRequests: [] }))
    expect(report.verdict).toBe("empty")
    expect(report.reasons).toStrictEqual([])
  })

  test("a passing open pull request with changes is ready", () => {
    const report = deriveShipReport(input())
    expect(report.verdict).toBe("ready")
    expect(report.reasons).toStrictEqual([])
  })

  test("changed files with no pull request are ready with the noPullRequest reason", () => {
    const report = deriveShipReport(input({ pullRequests: [] }))
    expect(report.verdict).toBe("ready")
    expect(report.reasons).toStrictEqual(["noPullRequest"])
  })

  test("noPullRequest also rides a working verdict", () => {
    const report = deriveShipReport(input({ threadStatus: "running", pullRequests: [] }))
    expect(report.verdict).toBe("working")
    expect(report.reasons).toStrictEqual(["threadRunning", "noPullRequest"])
  })
})

describe("deriveShipReport unavailable data", () => {
  test("an unresolved pull request pends instead of reading ready", () => {
    const report = deriveShipReport(input({ unresolvedPullRequests: 1 }))
    expect(report.verdict).toBe("pending")
    expect(report.reasons).toStrictEqual(["pullRequestUnknown"])
    expect(report.unresolvedPullRequests).toBe(1)
  })

  test("an unresolved pull request is not reported as missing", () => {
    const report = deriveShipReport(input({ pullRequests: [], unresolvedPullRequests: 2 }))
    expect(report.verdict).toBe("pending")
    expect(report.reasons).toStrictEqual(["pullRequestUnknown"])
  })

  test("unavailable changes pend instead of reading as zero changes", () => {
    const report = deriveShipReport(input({ changes: null, changesUnavailable: true }))
    expect(report.verdict).toBe("pending")
    expect(report.reasons).toStrictEqual(["changesUnknown"])
    expect(report.changesUnavailable).toBe(true)
  })

  test("blocked still beats unavailable data", () => {
    const report = deriveShipReport(
      input({ changesUnavailable: true, pullRequests: [pullRequest({ checks: "failing" })] }),
    )
    expect(report.verdict).toBe("blocked")
    expect(report.reasons).toStrictEqual(["checksFailing", "changesUnknown"])
  })

  test("markdown names unavailable changes and unresolved pull requests", () => {
    const report = deriveShipReport(
      input({ changes: null, changesUnavailable: true, pullRequests: [], unresolvedPullRequests: 1 }),
    )
    const markdown = shipReportMarkdown(report, "Loading")
    expect(markdown).toContain("Verdict: Pending")
    expect(markdown).toContain("Changes were not loaded")
    expect(markdown).not.toContain("0 files")
    expect(markdown).toContain("- 1 pull request was still loading")
  })
})

describe("deriveShipReport merged and closed pull requests", () => {
  test("a merged pull request does not block", () => {
    const report = deriveShipReport(
      input({
        pullRequests: [
          pullRequest({ status: "merged", checks: "failing", mergeable: "conflicting", review: "changesRequested" }),
        ],
      }),
    )
    expect(report.verdict).toBe("ready")
    expect(report.reasons).toStrictEqual([])
  })

  test("a closed pull request with failing checks does not block or pend", () => {
    const report = deriveShipReport(
      input({ pullRequests: [pullRequest({ status: "closed", checks: "pending", review: "reviewRequired" })] }),
    )
    expect(report.verdict).toBe("ready")
    expect(report.reasons).toStrictEqual([])
  })

  test("a merged pull request with no remaining changes is ready, not empty", () => {
    const report = deriveShipReport(
      input({ changes: { files: [], patch: "" }, pullRequests: [pullRequest({ status: "merged" })] }),
    )
    expect(report.verdict).toBe("ready")
    expect(report.reasons).toStrictEqual([])
  })
})

describe("deriveShipReport reasons and counts", () => {
  test("reasons follow the fixed order across two pull requests", () => {
    const report = deriveShipReport(
      input({
        pullRequests: [
          pullRequest({ number: 1, checks: "pending", review: "reviewRequired" }),
          pullRequest({ number: 2, checks: "failing", mergeable: "conflicting", review: "changesRequested" }),
        ],
      }),
    )
    expect(report.reasons).toStrictEqual([
      "checksFailing",
      "conflicting",
      "changesRequested",
      "checksPending",
      "reviewRequired",
    ])
  })

  test("the same reason from two pull requests appears once", () => {
    const report = deriveShipReport(
      input({
        pullRequests: [
          pullRequest({ number: 1, checks: "failing", mergeable: "conflicting" }),
          pullRequest({ number: 2, checks: "failing", mergeable: "conflicting" }),
        ],
      }),
    )
    expect(report.reasons).toStrictEqual(["checksFailing", "conflicting"])
  })

  test("added and removed count patch lines but not the file headers", () => {
    const report = deriveShipReport(
      input({
        changes: changes(
          "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n-older\n+new\n@@ -9,1 +9,2 @@\n+extra",
        ),
      }),
    )
    expect(report.added).toBe(2)
    expect(report.removed).toBe(2)
  })

  test("null changes mean no files and no lines", () => {
    const report = deriveShipReport(input({ changes: null }))
    expect(report.files).toStrictEqual([])
    expect(report.added).toBe(0)
    expect(report.removed).toBe(0)
  })

  test("null changes with no pull requests is empty", () => {
    const report = deriveShipReport(input({ changes: null, pullRequests: [] }))
    expect(report.verdict).toBe("empty")
    expect(report.reasons).toStrictEqual([])
  })

  test("files and pull requests pass through", () => {
    const report = deriveShipReport(input())
    expect(report.files).toStrictEqual([{ path: "src/a.ts", status: "modified" }])
    expect(report.pullRequests.map((entry) => entry.number)).toStrictEqual([1])
  })
})

describe("shipReportMarkdown", () => {
  test("a blocked report renders in full", () => {
    const report = deriveShipReport({
      threadStatus: "idle",
      changes: {
        files: [
          { path: "src/a.ts", status: "modified" },
          { path: "src/b.ts", status: "added" },
        ],
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context",
      },
      pullRequests: [
        pullRequest({
          number: 12,
          title: "Fix the thing",
          url: "https://github.com/o/r/pull/12",
          checks: "failing",
          mergeable: "conflicting",
        }),
      ],
    })
    expect(shipReportMarkdown(report, "Fix the thing")).toBe(
      [
        "## Ship report: Fix the thing",
        "",
        "Verdict: Blocked",
        "- Checks are failing",
        "- A pull request conflicts with its base",
        "",
        "### Changes",
        "",
        "2 files, +2 -1",
        "- src/a.ts (modified)",
        "- src/b.ts (added)",
        "",
        "### Pull requests",
        "",
        "- #12 Fix the thing (https://github.com/o/r/pull/12): open, checks failing, review approved",
      ].join("\n"),
    )
  })

  test("an empty report renders with no reasons and no pull request section", () => {
    const report = deriveShipReport({ threadStatus: "idle", changes: null, pullRequests: [] })
    expect(shipReportMarkdown(report, "Nothing here")).toBe(
      ["## Ship report: Nothing here", "", "Verdict: No changes", "", "### Changes", "", "0 files, +0 -0"].join("\n"),
    )
  })

  test("one file is singular and unknown checks and review are omitted", () => {
    const report = deriveShipReport(
      input({ pullRequests: [pullRequest({ checks: null, review: null, mergeable: "unknown" })] }),
    )
    expect(shipReportMarkdown(report, "One")).toBe(
      [
        "## Ship report: One",
        "",
        "Verdict: Ready",
        "",
        "### Changes",
        "",
        "1 file, +2 -1",
        "- src/a.ts (modified)",
        "",
        "### Pull requests",
        "",
        "- #1 First (https://github.com/o/r/pull/1): open",
      ].join("\n"),
    )
  })
})
