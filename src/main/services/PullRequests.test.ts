import { describe, expect, test } from "@effect/vitest"
import { parseGitHubPullRequestUrl } from "./PullRequests.ts"

describe("parseGitHubPullRequestUrl", () => {
  test("canonicalizes pull request URLs, dropping sub-pages, queries and hashes", () => {
    const canonical = "https://github.com/kjj6198/kkcode/pull/12"
    expect(parseGitHubPullRequestUrl(canonical)).toBe(canonical)
    expect(parseGitHubPullRequestUrl("https://github.com/kjj6198/kkcode/pull/12/files?diff=split#r1")).toBe(canonical)
    expect(parseGitHubPullRequestUrl("https://www.github.com/kjj6198/kkcode/pull/12/")).toBe(canonical)
  })

  test("rejects anything that is not a GitHub pull request", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/kjj6198/kkcode/issues/12")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("http://github.com/kjj6198/kkcode/pull/12")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("https://gitlab.com/kjj6198/kkcode/pull/12")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("https://github.com/kjj6198/kkcode/pull/abc")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("not a url")).toBeUndefined()
  })
})
