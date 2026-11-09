import { describe, expect, test } from "@effect/vitest"
import {
  mergeMethodsFor,
  offeredMergeMethod,
  parseGitLabMergeRequestUrl,
  parsePullRequestUrl,
  parseRemote,
  pullRequestNumberLabel,
} from "./codeHost.ts"

describe("parsePullRequestUrl", () => {
  test("keeps GitHub pull requests on github.com", () => {
    expect(parsePullRequestUrl(" https://github.com/hinadev-ai/hinacode/pull/617/files ")).toStrictEqual({
      host: "github",
      url: "https://github.com/hinadev-ai/hinacode/pull/617",
    })
  })

  test("reads GitLab merge requests on any host, with nested groups", () => {
    expect(parsePullRequestUrl("https://gitlab.com/gitlab-org/cli/-/merge_requests/4335/diffs")).toStrictEqual({
      host: "gitlab",
      url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/4335",
    })
    expect(
      parseGitLabMergeRequestUrl("https://git.example.co.jp:8443/platform/web/app/-/merge_requests/7"),
    ).toStrictEqual({ hostname: "git.example.co.jp:8443", path: "platform/web/app", iid: 7 })
  })

  test("rejects lookalikes", () => {
    for (const raw of [
      "http://gitlab.com/a/b/-/merge_requests/1",
      "https://gitlab.com/b/-/merge_requests/1",
      "https://gitlab.com/a/../-/merge_requests/1",
      "https://gitlab.com/a/b/-/merge_requests/0",
      "https://gitlab.com/a/b/merge_requests/1",
      "https://user:pass@gitlab.com/a/b/-/merge_requests/1",
      "https://gitlab.com/a/b/-/issues/1",
      "https://github.example.com/a/b/pull/1",
    ]) {
      expect(parsePullRequestUrl(raw), raw).toBeUndefined()
    }
  })
})

describe("parseRemote", () => {
  test("reads the host and project path from every remote form", () => {
    expect(parseRemote("git@gitlab.com:group/sub/project.git")).toStrictEqual({
      hostname: "gitlab.com",
      path: "group/sub/project",
    })
    expect(parseRemote("ssh://git@git.example.com:2222/group/project.git")).toStrictEqual({
      hostname: "git.example.com",
      path: "group/project",
    })
    expect(parseRemote("https://git.example.com:8443/group/project.git/")).toStrictEqual({
      hostname: "git.example.com:8443",
      path: "group/project",
    })
    expect(parseRemote("https://GitHub.com/hinadev-ai/hinacode")).toStrictEqual({
      hostname: "github.com",
      path: "hinadev-ai/hinacode",
    })
  })

  test("is undefined for local paths and single segments", () => {
    for (const remote of ["/srv/git/project.git", "../project", "git@gitlab.com:project.git", ""]) {
      expect(parseRemote(remote), remote).toBeUndefined()
    }
  })
})

test("labels merge requests with ! and pull requests with #", () => {
  expect(pullRequestNumberLabel("gitlab", 42)).toBe("!42")
  expect(pullRequestNumberLabel("github", 42)).toBe("#42")
})

test("offers no rebase on GitLab and falls back to the first offered method", () => {
  expect(mergeMethodsFor("gitlab")).toStrictEqual(["squash", "merge"])
  expect(mergeMethodsFor("github")).toStrictEqual(["squash", "merge", "rebase"])
  expect(offeredMergeMethod("rebase", mergeMethodsFor("gitlab"))).toBe("squash")
  expect(offeredMergeMethod("merge", mergeMethodsFor("gitlab"))).toBe("merge")
})
