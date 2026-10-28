import { describe, expect, it, test } from "@effect/vitest"
import { Effect, Layer, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
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
import type { PushEvent } from "../../shared/contract.ts"
import { parseGitHubPullRequestUrl } from "../../shared/github.ts"
import { Events } from "./Events.ts"

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
  mergeable: "UNKNOWN",
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

  test("maps mergeability and leaves one GitHub is still computing unknown", () => {
    expect(toPullRequest({ ...json, mergeable: "CONFLICTING" }).mergeable).toBe("conflicting")
    expect(toPullRequest(json).mergeable).toBe("unknown")
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
    changedFiles: 4,
    comments: [],
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

  test("orders failing, pending, passing, then skipped checks", () => {
    expect(toPullRequestDetail(detailJson)).toStrictEqual({
      ...toPullRequest(detailJson),
      body: "Adds a PR tab.",
      baseRef: "main",
      headRef: "feat/pr-tab",
      head: "abc1234",
      changedFiles: 4,
      comments: [],
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

interface GhReply {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
}

/** A `gh` that answers each command with `reply`, and records the arguments of every run and every push. */
const fakeGh = (reply: (args: ReadonlyArray<string>) => GhReply) => {
  const runs: Array<ReadonlyArray<string>> = []
  const pushed: Array<PushEvent> = []
  const events = Layer.succeed(Events, Events.of({ publish: (event) => Effect.sync(() => void pushed.push(event)) }))
  const spawner = ChildProcessSpawner.make((command) => {
    const args = command._tag === "StandardCommand" ? command.args : []
    runs.push(args)
    const { stdout = "", stderr = "", exitCode = 0 } = reply(args)
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.make(new TextEncoder().encode(stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return {
    runs,
    pushed,
    layer: layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      Layer.provide(events),
    ),
  }
}

const ghFails = (stderr: string) => fakeGh(() => ({ stderr, exitCode: 1 })).layer

describe("pull request actions", () => {
  const ghMustNotRun = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("gh must not run")),
  )
  const github = layer.pipe(
    Layer.provide(ghMustNotRun),
    Layer.provide(Layer.succeed(Events, Events.of({ publish: () => Effect.void }))),
  )

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

  it.effect("a diff GitHub refuses to serve fails as too large, not as a gh command", () =>
    Effect.gen(function* () {
      const gh = yield* GitHub
      const error = yield* Effect.flip(gh.pullRequestDiff("https://github.com/o/r/pull/24"))
      expect(error._tag).toBe("PullRequestDiffTooLargeError")
    }).pipe(
      Effect.provide(
        ghFails(
          "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) (https://api.github.com/repos/o/r/pulls/24)\nPullRequest.diff too_large\n",
        ),
      ),
    ),
  )
})

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

const PR_URL = "https://github.com/o/r/pull/7"

/** A pull request as GitHub's GraphQL API answers it, trimmed from a real answer for hinadev-ai/hinacode#379. */
const graphqlPullRequest = (title: string, state = "OPEN") => ({
  data: {
    repository: {
      pullRequest: {
        url: PR_URL,
        number: 7,
        title,
        state,
        isDraft: false,
        reviewDecision: null,
        mergeable: "MERGEABLE",
        author: { login: "octocat" },
        headRefName: "feat/x",
        baseRefName: "main",
        headRefOid: "abc",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        body: "",
        comments: {
          nodes: [
            {
              id: "IC_2",
              body: "Ready for another look.",
              createdAt: "2026-10-02T00:00:00Z",
              url: "https://github.com/o/r/pull/7#issuecomment-2",
              author: { login: "octocat" },
            },
          ],
        },
        reviews: {
          nodes: [
            {
              id: "PRR_1",
              body: "Two things before this lands.",
              createdAt: "2026-10-01T00:00:00Z",
              url: "https://github.com/o/r/pull/7#pullrequestreview-1",
              author: { login: "reviewer" },
            },
            {
              id: "PRR_3",
              body: "",
              createdAt: "2026-10-03T00:00:00Z",
              url: "https://github.com/o/r/pull/7#pullrequestreview-3",
              author: { login: "reviewer" },
            },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    body: "This leaks the handle.",
                    createdAt: "2026-10-01T00:00:01Z",
                    url: "https://github.com/o/r/pull/7#discussion_r1",
                    author: null,
                    path: "src/a.ts",
                    line: 12,
                  },
                ],
              },
            },
            {
              isResolved: true,
              comments: {
                nodes: [
                  {
                    id: "PRRC_2",
                    body: "Typo.",
                    createdAt: "2026-10-01T00:00:02Z",
                    url: "https://github.com/o/r/pull/7#discussion_r2",
                    author: { login: "reviewer" },
                    path: "src/b.ts",
                    line: 3,
                  },
                ],
              },
            },
          ],
        },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "e2e (macos)",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
                        checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                      },
                      {
                        __typename: "CheckRun",
                        name: "Workers Builds: site",
                        status: "IN_PROGRESS",
                        conclusion: null,
                        detailsUrl: "https://dash.cloudflare.com/builds/3",
                        checkSuite: { workflowRun: null },
                      },
                      {
                        __typename: "StatusContext",
                        context: "React Doctor",
                        state: "SUCCESS",
                        targetUrl: "https://github.com/o/r/actions/runs/4",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
})

interface Budget {
  readonly remaining?: number
  readonly limit?: number
  /** Epoch seconds. */
  readonly reset?: number
  readonly status?: string
  readonly retryAfter?: number
}

/** What `gh api --include` prints: the status line and headers, a blank line, then the body. */
const apiReply = (
  body: unknown,
  { remaining = 4000, limit = 5000, reset = 3600, status = "200 OK", retryAfter }: Budget = {},
): GhReply => {
  const json = JSON.stringify(body)
  const headers = [
    `X-Ratelimit-Limit: ${limit}`,
    `X-Ratelimit-Remaining: ${remaining}`,
    `X-Ratelimit-Reset: ${reset}`,
    "X-Ratelimit-Resource: graphql",
    `X-Ratelimit-Used: ${limit - remaining}`,
    ...(retryAfter === undefined ? [] : [`Retry-After: ${retryAfter}`]),
  ]
  const failed = !status.startsWith("200") || json.includes('"errors"')
  return { stdout: `HTTP/2.0 ${status}\n${headers.join("\r\n")}\r\n\r\n${json}`, exitCode: failed ? 1 : 0 }
}

const primaryLimitHit = (reset: number) =>
  apiReply(
    { errors: [{ type: "RATE_LIMITED", message: "API rate limit already exceeded for user ID 1." }] },
    { remaining: 0, reset },
  )

const secondaryLimitHit = (retryAfter?: number) =>
  apiReply(
    { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
    { remaining: 3000, status: "403 Forbidden", retryAfter },
  )

/** `gh api rate_limit` with the GraphQL budget used up until `reset`, in epoch seconds. */
const graphqlUsedUp = (reset: number) =>
  JSON.stringify({ resources: { core: { remaining: 4000, reset }, graphql: { remaining: 0, reset } } })

const isRead = (args: ReadonlyArray<string>) => args[0] === "api" && args[1] === "graphql"
const isRateLimitProbe = (args: ReadonlyArray<string>) => args[0] === "api" && args[1] === "rate_limit"

describe("pull request reads", () => {
  it.effect("reads a pull request and its checks from GitHub's GraphQL answer", () => {
    const gh = fakeGh(() => apiReply(graphqlPullRequest("Checks")))
    return Effect.gen(function* () {
      const detail = yield* (yield* GitHub).pullRequestDetail(PR_URL)
      expect(detail).toMatchObject({
        title: "Checks",
        status: "open",
        review: null,
        checks: "failing",
        author: "octocat",
      })
      expect(detail.checkRuns).toStrictEqual([
        { name: "CI / e2e (macos)", status: "failing", url: "https://github.com/o/r/actions/runs/1/job/2" },
        { name: "Workers Builds: site", status: "pending", url: "https://dash.cloudflare.com/builds/3" },
        { name: "React Doctor", status: "passing", url: "https://github.com/o/r/actions/runs/4" },
      ])
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("reads conversation, review and unresolved inline comments, oldest first", () => {
    const gh = fakeGh(() => apiReply(graphqlPullRequest("Comments")))
    return Effect.gen(function* () {
      const { comments } = yield* (yield* GitHub).pullRequestDetail(PR_URL)
      expect(comments.map(({ id, author, location }) => ({ id, author, location }))).toStrictEqual([
        { id: "PRR_1", author: "reviewer", location: null },
        { id: "PRRC_1", author: "ghost", location: { path: "src/a.ts", line: 12 } },
        { id: "IC_2", author: "octocat", location: null },
      ])
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("a comment posted through HinaCode shows on the next read", () => {
    const gh = fakeGh(() => apiReply(graphqlPullRequest("Commenting")))
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* github.pullRequestDetail(PR_URL)
      yield* github.comment(PR_URL, "--looks good")
      expect(gh.runs.at(-1)).toStrictEqual(["pr", "comment", PR_URL, "--body", "--looks good"])
      yield* github.pullRequestDetail(PR_URL)
      expect(gh.runs.filter(isRead)).toHaveLength(2)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("everyone asking about the same pull request shares one gh run while it is fresh", () => {
    const gh = fakeGh(() => apiReply(graphqlPullRequest("Shared")))
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* Effect.all([github.pullRequest(PR_URL), github.pullRequest(PR_URL), github.pullRequestDetail(PR_URL)], {
        concurrency: "unbounded",
      })
      yield* TestClock.adjust("29 seconds")
      yield* github.pullRequest(PR_URL)
      expect(gh.runs.filter(isRead)).toHaveLength(1)

      yield* TestClock.adjust("1 second")
      yield* github.pullRequest(PR_URL)
      expect(gh.runs.filter(isRead)).toHaveLength(2)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("a merge through HinaCode shows on the next read", () => {
    let state = "OPEN"
    const gh = fakeGh((args) => {
      if (args[1] === "merge") state = "MERGED"
      return apiReply(graphqlPullRequest("Merging", state))
    })
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* github.pullRequest(PR_URL)
      yield* github.merge(PR_URL, "squash")
      expect((yield* github.pullRequest(PR_URL)).status).toBe("merged")
    }).pipe(Effect.provide(gh.layer))
  })
})

describe("rate limits", () => {
  it.effect("does not run gh again until a used-up rate limit resets", () => {
    const gh = fakeGh(() => primaryLimitHit(3600))
    return Effect.gen(function* () {
      const github = yield* GitHub
      expect((yield* Effect.flip(github.pullRequest(PR_URL)))._tag).toBe("GitHubRateLimitedError")
      yield* TestClock.adjust("59 minutes")
      expect((yield* Effect.flip(github.pullRequestDetail(PR_URL)))._tag).toBe("GitHubRateLimitedError")
      expect((yield* Effect.flip(github.merge(PR_URL, "squash")))._tag).toBe("GitHubRateLimitedError")
      expect(gh.runs).toHaveLength(1)

      yield* TestClock.adjust("1 minute")
      yield* Effect.flip(github.pullRequest(PR_URL))
      expect(gh.runs).toHaveLength(2)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("stops before GitHub refuses once a response says nothing is left", () => {
    const gh = fakeGh(() => apiReply(graphqlPullRequest("Last one"), { remaining: 0, reset: 600 }))
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* github.pullRequest(PR_URL)
      yield* TestClock.adjust("9 minutes")
      expect((yield* github.pullRequest(PR_URL)).title).toBe("Last one")
      expect(gh.runs).toHaveLength(1)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("waits as long as retry-after asks after a secondary rate limit", () => {
    const gh = fakeGh(() => secondaryLimitHit(120))
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* Effect.flip(github.pullRequest(PR_URL))
      yield* TestClock.adjust("119 seconds")
      yield* Effect.flip(github.pullRequest(PR_URL))
      expect(gh.runs.filter(isRead)).toHaveLength(1)

      yield* TestClock.adjust("1 second")
      yield* Effect.flip(github.pullRequest(PR_URL))
      expect(gh.runs.filter(isRead)).toHaveLength(2)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("waits a minute after a secondary rate limit without retry-after, then twice as long", () => {
    const gh = fakeGh(() => secondaryLimitHit())
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* Effect.flip(github.pullRequest(PR_URL))
      yield* TestClock.adjust("59 seconds")
      yield* Effect.flip(github.pullRequest(PR_URL))
      expect(gh.runs.filter(isRead)).toHaveLength(1)

      yield* TestClock.adjust("1 second")
      yield* Effect.flip(github.pullRequest(PR_URL))
      expect(gh.runs.filter(isRead)).toHaveLength(2)

      yield* TestClock.adjust("119 seconds")
      yield* Effect.flip(github.pullRequest(PR_URL))
      expect(gh.runs.filter(isRead)).toHaveLength(2)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("a rate limit another gh command hits pauses pull request reads too", () => {
    const gh = fakeGh((args) => {
      if (isRateLimitProbe(args)) return { stdout: graphqlUsedUp(3600) }
      if (args[1] === "merge")
        return { stderr: "GraphQL: API rate limit already exceeded for user ID 1.\n", exitCode: 1 }
      return apiReply(graphqlPullRequest("Unread"))
    })
    return Effect.gen(function* () {
      const github = yield* GitHub
      expect((yield* Effect.flip(github.merge(PR_URL, "squash")))._tag).toBe("GitHubRateLimitedError")
      expect((yield* Effect.flip(github.pullRequest(PR_URL)))._tag).toBe("GitHubRateLimitedError")
      expect(gh.runs.filter(isRead)).toHaveLength(0)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("keeps answering with the last read while GitHub is rate limited", () => {
    let limited = false
    const gh = fakeGh(() => (limited ? primaryLimitHit(3600) : apiReply(graphqlPullRequest("Before the limit"))))
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* github.pullRequest(PR_URL)
      limited = true
      yield* TestClock.adjust("5 minutes")
      expect((yield* github.pullRequest(PR_URL)).title).toBe("Before the limit")
      expect((yield* github.pullRequestDetail(PR_URL)).title).toBe("Before the limit")
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("refreshes pull requests every 5 minutes once less than a fifth of the budget is left", () => {
    const gh = fakeGh(() => apiReply(graphqlPullRequest("Low"), { remaining: 999 }))
    return Effect.gen(function* () {
      const github = yield* GitHub
      yield* github.pullRequest(PR_URL)
      yield* TestClock.adjust("4 minutes")
      yield* github.pullRequest(PR_URL)
      expect(gh.runs.filter(isRead)).toHaveLength(1)

      yield* TestClock.adjust("1 minute")
      yield* github.pullRequest(PR_URL)
      expect(gh.runs.filter(isRead)).toHaveLength(2)
    }).pipe(Effect.provide(gh.layer))
  })

  it.effect("tells the windows once when the budget runs low and once when it runs out", () => {
    let remaining = 4000
    const gh = fakeGh(() => apiReply(graphqlPullRequest("Budget"), { remaining, reset: 3600 }))
    return Effect.gen(function* () {
      const github = yield* GitHub
      const readFresh = Effect.andThen(TestClock.adjust("5 minutes"), github.pullRequest(PR_URL))
      for (const left of [4000, 999, 600, 0]) {
        remaining = left
        yield* readFresh
      }
      expect(gh.pushed).toStrictEqual([
        {
          type: "github.rateLimit",
          level: "low",
          rateLimit: { resource: "graphql", limit: 5000, remaining: 999, used: 4001, resetsAt: 3_600_000 },
        },
        {
          type: "github.rateLimit",
          level: "exhausted",
          rateLimit: { resource: "graphql", limit: 5000, remaining: 0, used: 5000, resetsAt: 3_600_000 },
        },
      ])
    }).pipe(Effect.provide(gh.layer))
  })
})
