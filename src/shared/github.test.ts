import { describe, expect, test } from "@effect/vitest"
import { parseGitHubRepository } from "./github.ts"

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
