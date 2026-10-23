import { describe, expect, it, test } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  GitHub,
  layer,
  parseAuthStatus,
  pullRequestFiles,
  summarizeChecks,
  toPullRequest,
  toPullRequestDetail,
} from "./GitHub.ts"
import { parseGitHubPullRequestUrl } from "../../shared/github.ts"

const account = (overrides: Partial<{ state: string; active: boolean; login: string }>) => ({
  state: "success",
  active: true,
  host: "github.com",
  login: "octocat",
  ...overrides,
})

describe("parseAuthStatus", () => {
  test("no hosts means signed out", () => {
    expect(parseAuthStatus({ hosts: {} })).toStrictEqual({ type: "signedOut" })
  })

  test("prefers the active account over another verified one", () => {
    const hosts = { "github.com": [account({ active: false, login: "other" }), account({ login: "me" })] }
    expect(parseAuthStatus({ hosts })).toStrictEqual({ type: "signedIn", host: "github.com", login: "me" })
  })

  test("a login whose token failed to verify does not count", () => {
    expect(parseAuthStatus({ hosts: { "github.com": [account({ state: "error" })] } })).toStrictEqual({
      type: "signedOut",
    })
  })
})

const run = (status: string, conclusion = "") => ({ status, conclusion })
const commitStatus = (state: string) => ({ state })

describe("summarizeChecks", () => {
  test("no checks is null, not passing", () => {
    expect(summarizeChecks([])).toBe(null)
  })

  test("only skipped or neutral checks is null", () => {
    expect(summarizeChecks([run("COMPLETED", "SKIPPED"), run("COMPLETED", "NEUTRAL")])).toBe(null)
  })

  test("a failure wins over a running check", () => {
    expect(summarizeChecks([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")])).toBe("failing")
  })

  test("a running check wins over successes", () => {
    expect(summarizeChecks([run("COMPLETED", "SUCCESS"), run("QUEUED")])).toBe("pending")
  })

  test("commit statuses count like check runs", () => {
    expect(summarizeChecks([commitStatus("SUCCESS"), run("COMPLETED", "SKIPPED")])).toBe("passing")
    expect(summarizeChecks([commitStatus("PENDING")])).toBe("pending")
    expect(summarizeChecks([commitStatus("ERROR")])).toBe("failing")
  })
})

const json = {
  url: "https://github.com/a/b/pull/1",
  number: 1,
  title: "Fix",
  state: "OPEN" as const,
  isDraft: false,
  reviewDecision: "",
  statusCheckRollup: [],
  author: { login: "octocat" },
  headRefName: "kk/fix",
  baseRefName: "main",
  additions: 3,
  deletions: 1,
}

describe("toPullRequest", () => {
  test("an open draft is a draft, a closed draft is closed", () => {
    expect(toPullRequest({ ...json, isDraft: true }).status).toBe("draft")
    expect(toPullRequest({ ...json, isDraft: true, state: "CLOSED" }).status).toBe("closed")
  })

  test("carries the author's login, branches and size", () => {
    expect(toPullRequest(json)).toMatchObject({
      author: "octocat",
      headRefName: "kk/fix",
      baseRefName: "main",
      additions: 3,
      deletions: 1,
    })
  })

  test("maps the review decision and leaves an empty one null", () => {
    expect(toPullRequest({ ...json, reviewDecision: "CHANGES_REQUESTED" }).review).toBe("changesRequested")
    expect(toPullRequest(json).review).toBe(null)
  })
})

describe("toPullRequestDetail", () => {
  const detailJson = {
    ...json,
    url: "https://github.com/hinadev-ai/hinacode/pull/60",
    number: 60,
    title: "feat(github): pull request tab",
    reviewDecision: "REVIEW_REQUIRED",
    body: "Adds a PR tab.",
    baseRefName: "main",
    headRefName: "feat/pr-tab",
    headRefOid: "abc1234",
    mergeable: "CONFLICTING",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "lint",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/hinadev-ai/hinacode/actions/runs/1/job/1",
      },
      { __typename: "CheckRun", name: "docs", workflowName: "", status: "COMPLETED", conclusion: "SKIPPED" },
      {
        __typename: "CheckRun",
        name: "test",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/hinadev-ai/hinacode/actions/runs/1/job/2",
      },
      {
        __typename: "StatusContext",
        context: "vercel",
        state: "PENDING",
        targetUrl: "https://vercel.com/hinadev-ai/hinacode/abc",
      },
      { __typename: "CheckRun", name: "Build", workflowName: "Build", status: "COMPLETED", conclusion: "NEUTRAL" },
    ],
  }

  test("orders failing, pending, passing, then skipped checks and maps mergeability", () => {
    expect(toPullRequestDetail(detailJson)).toStrictEqual({
      ...toPullRequest(detailJson),
      body: "Adds a PR tab.",
      baseRef: "main",
      headRef: "feat/pr-tab",
      head: "abc1234",
      mergeable: "conflicting",
      checkRuns: [
        { name: "CI / test", status: "failing", url: "https://github.com/hinadev-ai/hinacode/actions/runs/1/job/2" },
        { name: "vercel", status: "pending", url: "https://vercel.com/hinadev-ai/hinacode/abc" },
        { name: "CI / lint", status: "passing", url: "https://github.com/hinadev-ai/hinacode/actions/runs/1/job/1" },
        { name: "docs", status: "skipped", url: null },
        { name: "Build", status: "skipped", url: null },
      ],
    })
  })

  test("mergeability GitHub has not computed yet is unknown", () => {
    expect(toPullRequestDetail({ ...detailJson, mergeable: "MERGEABLE" }).mergeable).toBe("mergeable")
    expect(toPullRequestDetail({ ...detailJson, mergeable: "UNKNOWN" }).mergeable).toBe("unknown")
  })
})

describe("parseGitHubPullRequestUrl", () => {
  test("canonicalizes pull request URLs, dropping sub-pages, queries and hashes", () => {
    const canonical = "https://github.com/hinadev-ai/hinacode/pull/12"
    expect(parseGitHubPullRequestUrl(canonical)).toBe(canonical)
    expect(parseGitHubPullRequestUrl("https://github.com/hinadev-ai/hinacode/pull/12/files?diff=split#r1")).toBe(
      canonical,
    )
    expect(parseGitHubPullRequestUrl("https://www.github.com/hinadev-ai/hinacode/pull/12/")).toBe(canonical)
  })

  test("rejects anything that is not a GitHub pull request", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/hinadev-ai/hinacode/issues/12")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("http://github.com/hinadev-ai/hinacode/pull/12")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("https://gitlab.com/hinadev-ai/hinacode/pull/12")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("https://github.com/hinadev-ai/hinacode/pull/abc")).toBeUndefined()
    expect(parseGitHubPullRequestUrl("not a url")).toBeUndefined()
  })
})

describe("pull request actions", () => {
  const ghMustNotRun = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("gh must not run")),
  )
  const github = layer.pipe(Layer.provide(ghMustNotRun))

  it.effect("reject a URL that is not a pull request before running gh", () =>
    Effect.gen(function* () {
      const gh = yield* GitHub
      const actions: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        gh.pullRequest("--admin"),
        gh.pullRequestDetail("--admin"),
        gh.merge("--admin", "squash"),
        gh.close("--admin"),
      ]
      for (const action of actions) {
        const error = yield* Effect.flip(action)
        expect(error._tag).toBe("PullRequestUrlInvalidError")
      }
    }).pipe(Effect.provide(github)),
  )
})

// `git diff` of a modify, an add, a delete, a binary change and a rename, the format `gh pr diff` prints.
const DIFF = `diff --git a/a.txt b/a.txt
index 4cb29ea..ea14db2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 one
-two
+2
 three
+four
diff --git a/added.md b/added.md
new file mode 100644
index 0000000..fa49b07
--- /dev/null
+++ b/added.md
@@ -0,0 +1 @@
+new file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 2fa992c..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-keep
diff --git a/logo.png b/logo.png
index f584f40..6bf43ff 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/old-name.ts b/src-new-name.ts
similarity index 73%
rename from old-name.ts
rename to src-new-name.ts
index 7a28df3..adc7e54 100644
--- a/old-name.ts
+++ b/src-new-name.ts
@@ -1,4 +1,4 @@
 alpha
 beta
 gamma
-delta
+DELTA
`

describe("pullRequestFiles", () => {
  it.effect("reads each file's status and counts, and keeps its own section of the diff", () =>
    Effect.gen(function* () {
      const files = yield* pullRequestFiles(DIFF)
      expect(files.map((file) => ({ ...file, patch: undefined }))).toStrictEqual([
        {
          path: "a.txt",
          previousPath: null,
          status: "modified",
          additions: 2,
          deletions: 1,
          binary: false,
          patch: undefined,
        },
        {
          path: "added.md",
          previousPath: null,
          status: "added",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: undefined,
        },
        {
          path: "gone.txt",
          previousPath: null,
          status: "removed",
          additions: 0,
          deletions: 1,
          binary: false,
          patch: undefined,
        },
        {
          path: "logo.png",
          previousPath: null,
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
          patch: undefined,
        },
        {
          path: "src-new-name.ts",
          previousPath: "old-name.ts",
          status: "renamed",
          additions: 1,
          deletions: 1,
          binary: false,
          patch: undefined,
        },
      ])
      expect(files[0]?.patch).toBe(DIFF.slice(0, DIFF.indexOf("diff --git a/added.md")))
      expect(files.map((file) => file.patch).join("")).toBe(DIFF)
    }),
  )

  it.effect("an empty diff has no files", () =>
    Effect.gen(function* () {
      expect(yield* pullRequestFiles("")).toStrictEqual([])
    }),
  )
})
