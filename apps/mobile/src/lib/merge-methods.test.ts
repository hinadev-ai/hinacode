import { describe, expect, it } from "vitest"
import { mergeChoice } from "./merge-methods"

const gitLab = "https://gitlab.com/gitlab-org/cli/-/merge_requests/4406"
const gitHub = "https://github.com/hinadev-ai/hinacode/pull/891"

describe("mergeChoice", () => {
  it("offers GitLab only the methods its merge accepts", () => {
    expect(mergeChoice(gitLab, "squash").methods).toStrictEqual(["squash", "merge"])
  })

  it("falls back from rebase to squash on a GitLab merge request", () => {
    expect(mergeChoice(gitLab, "rebase").method).toBe("squash")
  })

  it("offers GitHub all three methods and keeps the chosen one", () => {
    expect(mergeChoice(gitHub, "rebase")).toStrictEqual({ methods: ["squash", "merge", "rebase"], method: "rebase" })
  })
})
