import { describe, expect, test } from "@effect/vitest"
import { Schema } from "effect"
import { GitRefName, linearReviewUrl, parseGitHubRepository, RepositoryPath } from "./github.ts"

const repo = { owner: "kjj6198", name: "myprofile" }

describe("parseGitHubRepository", () => {
  test("reads owner/repo in every form people paste", () => {
    for (const input of [
      "kjj6198/myprofile",
      "  kjj6198/myprofile  ",
      "https://github.com/kjj6198/myprofile",
      "https://github.com/kjj6198/myprofile.git",
      "https://github.com/kjj6198/myprofile/",
      "http://www.github.com/kjj6198/myprofile",
      "github.com/kjj6198/myprofile",
      "https://github.com/kjj6198/myprofile/tree/main/src",
      "https://github.com/kjj6198/myprofile/pull/12",
      "git@github.com:kjj6198/myprofile.git",
      "ssh://git@github.com/kjj6198/myprofile.git",
      "git clone https://github.com/kjj6198/myprofile.git",
      "gh repo clone kjj6198/myprofile",
    ]) {
      expect(parseGitHubRepository(input), input).toStrictEqual(repo)
    }
  })

  test("keeps dots, underscores and dashes in repository names", () => {
    expect(parseGitHubRepository("vercel/next.js")).toStrictEqual({ owner: "vercel", name: "next.js" })
    expect(parseGitHubRepository("my-org/repo_name-2")).toStrictEqual({ owner: "my-org", name: "repo_name-2" })
  })

  test("leaves local paths and anything else alone", () => {
    for (const input of [
      "",
      "/Users/kalan/code/app",
      "~/code/app",
      "./app",
      "../app",
      "C:\\code\\app",
      "code/app/src",
      "kjj6198",
      "kjj6198/..",
      "https://gitlab.com/kjj6198/myprofile",
      "https://github.com/kjj6198",
    ]) {
      expect(parseGitHubRepository(input), input).toBeNull()
    }
  })
})

describe("linearReviewUrl", () => {
  test("moves a pull request and its subpages to linear.review", () => {
    expect(linearReviewUrl("https://github.com/linear/linear/pull/1311")).toBe(
      "https://linear.review/linear/linear/pull/1311",
    )
    expect(linearReviewUrl("https://github.com/linear/linear/pull/1311/files")).toBe(
      "https://linear.review/linear/linear/pull/1311/files",
    )
  })

  test("leaves other urls alone", () => {
    for (const url of ["https://github.com/linear/linear/issues/4", "https://example.com/a/b/pull/1"])
      expect(linearReviewUrl(url)).toBe(url)
  })
})

describe("file paths and refs sent to the GitHub API", () => {
  test("allow paths inside the repository and branch or commit refs", () => {
    expect(Schema.is(RepositoryPath)("assets/my logo.png")).toBe(true)
    expect(Schema.is(GitRefName)("feat/diff-review")).toBe(true)
    expect(Schema.is(GitRefName)("433c5ea")).toBe(true)
  })

  test("refuse anything that could climb out to another API path", () => {
    for (const path of ["../../user", "a/../b", "/etc", "a//b", "a/"])
      expect(Schema.is(RepositoryPath)(path)).toBe(false)
    for (const ref of ["../main", "main?x=1", "a b", "main&ref=x"]) expect(Schema.is(GitRefName)(ref)).toBe(false)
  })
})
