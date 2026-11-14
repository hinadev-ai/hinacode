import { describe, expect, it } from "vitest"
import { touchesPullRequest } from "./pullRequestCommand.ts"

describe("touchesPullRequest", () => {
  it.each([
    { command: "gh pr merge 7 --squash" },
    { command: "cd repo && gh pr close https://github.com/o/r/pull/7" },
    { command: "gh pr reopen 7" },
    { command: "gh pr ready" },
    { command: "gh api -X PUT repos/o/r/pulls/7/merge" },
    { command: "glab mr merge 3" },
    { command: "git push -u origin feat/x" },
    { command: ["bash", "-lc", "gh pr merge --auto --squash"] },
    { command: "cd /repo\ngh pr merge 7 --squash" },
    { command: "pnpm test\ngit push origin HEAD" },
    { command: "gh --repo o/r pr merge 7 --squash" },
    { command: "git -C /repo push origin HEAD" },
  ])("matches $command", (input) => {
    expect(touchesPullRequest(input)).toBe(true)
  })

  it.each([
    { command: "gh pr view 7" },
    { command: "gh pr list" },
    { command: "gh api repos/o/r/issues/7" },
    { command: "git pull" },
    { command: "git status && gh pr view 7" },
    { file_path: "src/pulls.ts" },
    undefined,
  ])("ignores %o", (input) => {
    expect(touchesPullRequest(input)).toBe(false)
  })
})
