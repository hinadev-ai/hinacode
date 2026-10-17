import { describe, expect, test } from "@effect/vitest"
import type { PullRequestDetail } from "./domain.ts"
import { fixChecksPrompt, resolveConflictsPrompt } from "./pullRequestPrompts.ts"

const pullRequest = {
  url: "https://github.com/acme/app/pull/7",
  headRef: "fix/login",
  baseRef: "main",
  checkRuns: [
    { name: "lint", status: "passing", url: null },
    { name: "test", status: "failing", url: "https://github.com/acme/app/actions/runs/1" },
    { name: "e2e", status: "failing", url: null },
  ],
} as unknown as PullRequestDetail

describe("fixChecksPrompt", () => {
  test("lists only the failing checks, with their URLs when GitHub has one", () => {
    expect(fixChecksPrompt(pullRequest)).toBe(
      [
        "CI is failing on https://github.com/acme/app/pull/7 (branch fix/login). Failing checks:",
        "- test: https://github.com/acme/app/actions/runs/1",
        "- e2e",
        "",
        "Read the failing logs (for GitHub Actions, `gh run view <run-id> --log-failed`), find the root cause, fix it, verify locally, and push.",
      ].join("\n"),
    )
  })
})

describe("resolveConflictsPrompt", () => {
  test("names the pull request and both branches", () => {
    expect(resolveConflictsPrompt(pullRequest)).toBe(
      "https://github.com/acme/app/pull/7 has merge conflicts with main. Fetch origin, merge origin/main into fix/login, and resolve the conflicts so both sides keep their intent. Run the project's checks, then push.",
    )
  })
})
