import { describe, expect, test } from "@effect/vitest"
import type { PullRequestDetail } from "./domain.ts"
import { fixChecksPrompt } from "./pullRequestPrompts.ts"

const pullRequest = {
  url: "https://github.com/acme/app/pull/7",
  headRef: "fix/login",
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

